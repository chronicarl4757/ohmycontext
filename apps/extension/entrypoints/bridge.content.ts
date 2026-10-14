import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';
import { normalizeChatGptConversation, normalizeClaudeConversation, type OmcEvent } from '../lib/normalize';

// Isolated-world bridge: receives raw site payloads from the MAIN-world
// pagehook via postMessage, normalizes them into OMC events, and relays them
// to the background worker (which owns the network path to the daemon).

async function normalize(site: string, data: unknown): Promise<OmcEvent[]> {
  if (site === 'chatgpt') return normalizeChatGptConversation(data);
  if (site === 'claude') return normalizeClaudeConversation(data);
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
      const res = await fetch(`/backend-api/conversation/${m[1]}`, { credentials: 'include' });
      if (!res.ok) return { ok: false, events: 0 };
      const events = await normalizeChatGptConversation(await res.json());
      return { ok: true, events: await sendEvents(events, location.href) };
    }
    if (host.endsWith('claude.ai')) {
      const m = /\/chat\/([0-9a-f-]{36})/.exec(page);
      if (!m) return { ok: false, events: 0 };
      const orgs = (await (await fetch('/api/organizations', { credentials: 'include' })).json()) as unknown;
      const org = Array.isArray(orgs) && orgs[0] && typeof orgs[0] === 'object'
        ? (orgs[0] as Record<string, unknown>).uuid
        : undefined;
      if (typeof org !== 'string') return { ok: false, events: 0 };
      const res = await fetch(`/api/organizations/${org}/chat_conversations/${m[1]}?tree=True&rendering_mode=messages&render_all_tools=true`, { credentials: 'include' });
      if (!res.ok) return { ok: false, events: 0 };
      const events = await normalizeClaudeConversation(await res.json());
      return { ok: true, events: await sendEvents(events, location.href) };
    }
    return { ok: false, events: 0 };
  } catch {
    return { ok: false, events: 0 };
  }
}

export default defineContentScript({
  matches: ['*://chatgpt.com/*', '*://claude.ai/*'],
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
      const d = ev.data as { source?: string; site?: string; pageUrl?: string; data?: unknown } | null;
      if (!d || d.source !== 'omc-pagehook' || typeof d.site !== 'string') return;
      void (async () => {
        if (!enabled) return;
        try {
          await sendEvents(await normalize(d.site as string, d.data), String(d.pageUrl ?? ''));
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
