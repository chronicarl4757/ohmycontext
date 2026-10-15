import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';
import {
  normalizeChatGptConversation,
  normalizeClaudeConversation,
  normalizeDeepSeek,
  normalizeKimi,
  normalizeKimiApiv2,
  type OmcEvent,
} from '../lib/normalize';
import { readChatGptToken, readDeepSeekToken, readKimiToken } from '../lib/tokens';

// Isolated-world bridge: receives site payloads + diagnostics from the
// MAIN-world pagehook via postMessage, normalizes payloads into OMC events,
// and relays everything to the background worker.

const MATCHES = [
  '*://chatgpt.com/*',
  '*://claude.ai/*',
  '*://chat.deepseek.com/*',
  '*://kimi.com/*',
  '*://*.kimi.com/*',
  '*://kimi.moonshot.cn/*',
  '*://*.kimi.moonshot.cn/*',
];

async function normalize(
  site: string,
  data: unknown,
  extra: { chatId?: string; title?: string },
): Promise<OmcEvent[]> {
  if (site === 'chatgpt') return normalizeChatGptConversation(data);
  if (site === 'claude') return normalizeClaudeConversation(data);
  if (site === 'deepseek') return normalizeDeepSeek({ messages: data, ...extra });
  if (site === 'kimi') {
    const d = data as Record<string, unknown> | null;
    if (d && typeof d === 'object' && 'listMessages' in d) {
      return normalizeKimiApiv2(
        (d as { getChat?: unknown }).getChat ?? null,
        (d as { listMessages?: unknown }).listMessages,
        extra.chatId ?? '',
      );
    }
    return normalizeKimi({ items: data, ...extra }); // legacy segment/scroll shape
  }
  return [];
}

async function sendEvents(events: OmcEvent[], pageUrl: string): Promise<number> {
  if (events.length === 0) return 0;
  await browser.runtime.sendMessage({ type: 'omc-events', events, pageUrl });
  return events.length;
}

async function captureNow(): Promise<{ ok: boolean; events: number }> {
  try {
    const host = location.hostname;
    const page = location.pathname;
    if (host.endsWith('chatgpt.com')) {
      const m = /\/c\/([0-9a-f-]{36})/.exec(page);
      if (!m) return { ok: false, events: 0 };
      const token = await readChatGptToken(fetch);
      const res = await fetch(`/backend-api/conversation/${m[1]}`, {
        credentials: 'include',
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) return { ok: false, events: 0 };
      return { ok: true, events: await sendEvents(await normalizeChatGptConversation(await res.json()), location.href) };
    }
    if (host.endsWith('claude.ai')) {
      const m = /\/chat\/([0-9a-f-]{36})/.exec(page);
      if (!m) return { ok: false, events: 0 };
      const orgs = (await (await fetch('/api/organizations', { credentials: 'include' })).json()) as unknown;
      const org =
        Array.isArray(orgs) && orgs[0] && typeof orgs[0] === 'object'
          ? (orgs[0] as Record<string, unknown>).uuid
          : undefined;
      if (typeof org !== 'string') return { ok: false, events: 0 };
      const res = await fetch(
        `/api/organizations/${org}/chat_conversations/${m[1]}?tree=True&rendering_mode=messages&render_all_tools=true`,
        { credentials: 'include' },
      );
      if (!res.ok) return { ok: false, events: 0 };
      return { ok: true, events: await sendEvents(await normalizeClaudeConversation(await res.json()), location.href) };
    }
    if (host.endsWith('chat.deepseek.com')) {
      const m = /\/(?:a\/)?chat\/s\/([0-9a-f-]{36})/.exec(page);
      const token = readDeepSeekToken();
      if (!m || !token) return { ok: false, events: 0 };
      const res = await fetch(`/api/v0/chat/history_messages?chat_session_id=${m[1]}`, {
        credentials: 'include',
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) return { ok: false, events: 0 };
      const events = await normalizeDeepSeek({ messages: await res.json(), chatId: m[1] });
      return { ok: true, events: await sendEvents(events, location.href) };
    }
    if (host.endsWith('kimi.com') || host.endsWith('kimi.moonshot.cn')) {
      const m = /\/chat\/([0-9a-z]{8,64})/.exec(page);
      const token = readKimiToken();
      const chatId = m?.[1];
      if (!chatId || !token) return { ok: false, events: 0 };
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
      const [listRes, chatRes] = await Promise.all([
        fetch('/apiv2/kimi.gateway.chat.v1.ChatService/ListMessages', {
          method: 'POST',
          credentials: 'include',
          headers,
          body: JSON.stringify({ chat_id: chatId, page_size: 100 }),
        }),
        fetch('/apiv2/kimi.gateway.chat.v1.ChatService/GetChat', {
          method: 'POST',
          credentials: 'include',
          headers,
          body: JSON.stringify({ chat_id: chatId }),
        }),
      ]);
      if (!listRes.ok) return { ok: false, events: 0 };
      const getChat = chatRes.ok ? await chatRes.json().catch(() => null) : null;
      const events = await normalizeKimiApiv2(getChat, await listRes.json(), chatId);
      return { ok: true, events: await sendEvents(events, location.href) };
    }
    return { ok: false, events: 0 };
  } catch {
    return { ok: false, events: 0 };
  }
}

export default defineContentScript({
  matches: MATCHES,
  runAt: 'document_start',
  main() {
    let enabled = true;
    void browser.storage.sync.get({ omcCaptureEnabled: true }).then((v) => {
      enabled = Boolean(v.omcCaptureEnabled);
    });
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes.omcCaptureEnabled) {
        enabled = Boolean(changes.omcCaptureEnabled.newValue);
      }
    });

    window.addEventListener('message', (ev) => {
      if (ev.source !== window) return;
      const d = ev.data as
        | { source?: string; kind?: string; site?: string; pageUrl?: string; data?: unknown; chatId?: string; title?: string; event?: string; detail?: string }
        | null;
      if (!d || d.source !== 'omc-pagehook' || typeof d.site !== 'string') return;
      if (d.kind === 'diag') {
        void browser.runtime
          .sendMessage({ type: 'omc-diag', site: d.site, event: d.event, detail: d.detail })
          .catch(() => {});
        return;
      }
      void (async () => {
        if (!enabled) return;
        try {
          const events = await normalize(d.site as string, d.data, {
            ...(typeof d.chatId === 'string' ? { chatId: d.chatId } : {}),
            ...(typeof d.title === 'string' ? { title: d.title } : {}),
          });
          await sendEvents(events, String(d.pageUrl ?? ''));
        } catch {
          // background gone (extension reloaded); drop silently
        }
      })();
    });

    browser.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
      if ((msg as { type?: string } | null)?.type !== 'omc-capture-now') return undefined;
      void captureNow().then(sendResponse);
      return true;
    });
  },
});
