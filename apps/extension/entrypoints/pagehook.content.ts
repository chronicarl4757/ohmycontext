import { defineContentScript } from 'wxt/utils/define-content-script';
import { readChatGptToken, readDeepSeekToken, readKimiToken } from '../lib/tokens';

// Runs in the page's MAIN world and observes the site's own backend API
// traffic (fetch AND XHR). It sniffs Authorization headers from the site's own
// requests (cached per site in memory) and falls back to documented token
// sources. Everything is wrapped in try/catch: capture must never break the
// host page.

type Site = 'chatgpt' | 'claude' | 'deepseek' | 'kimi';

const HOST_SITE: Record<string, Site> = {
  'chatgpt.com': 'chatgpt',
  'claude.ai': 'claude',
  'chat.deepseek.com': 'deepseek',
  'kimi.com': 'kimi',
  'kimi.moonshot.cn': 'kimi',
};

const CHATGPT_CONVERSATION_RE = /\/backend-api\/(?:f\/)?conversation\/([0-9a-f-]{36})/;
const CHATGPT_STREAM_RE = /\/backend-api\/(?:f\/)?conversation\/?(\?|$)/;
const CLAUDE_CONVERSATION_RE = /\/api\/organizations\/([^/?]+)\/chat_conversations\/([0-9a-f-]{36})/;
const DEEPSEEK_HISTORY_RE = /\/api\/v0\/chat\/history_messages\?/;
const DEEPSEEK_STREAM_RE = /\/api\/v0\/chat\/completion\/?(\?|$)/;
const DEEPSEEK_PAGE_RE = /\/(?:a\/)?chat\/s\/([0-9a-z]{8,64})/;
// kimi 2026: Connect-RPC JSON POSTs under /apiv2 (verified against live traffic)
const KIMI_LIST_MESSAGES_RE = /\/apiv2\/kimi\.gateway\.chat\.v1\.ChatService\/ListMessages/;
const KIMI_GET_CHAT_RE = /\/apiv2\/kimi\.gateway\.chat\.v1\.ChatService\/GetChat/;
const KIMI_STREAM_RE = /\/apiv2\/kimi\.gateway\.chat\.v1\.ChatService\/(Stream|Send|Complete)/;
const KIMI_PAGE_RE = /\/chat\/([0-9a-z]{8,64})/;

const sniffedAuth = new Map<Site, string>();
const sniffedSessionId = new Map<Site, string>();
const kimiTitles = new Map<string, string>();

function currentSite(): Site | null {
  // real apps may live on www.<host> (kimi does) — normalize before lookup
  const host = location.hostname.toLowerCase().replace(/^www\./, '');
  return HOST_SITE[host] ?? null;
}

function post(payload: Record<string, unknown>): void {
  try {
    window.postMessage({ source: 'omc-pagehook', ...payload }, location.origin);
  } catch {
    // ignore
  }
}

function diag(site: Site, event: string, detail: string): void {
  const redacted = detail
    .split('/')
    .map((seg) => (seg.length > 12 ? `${seg.slice(0, 8)}…` : seg))
    .join('/')
    .slice(0, 160);
  post({ kind: 'diag', site, event, detail: redacted });
}

function sniffAuth(site: Site, headers: unknown): void {
  try {
    const found: { auth?: string; sessionId?: string } = {};
    const read = (k: string, v: unknown) => {
      const key = k.toLowerCase();
      if (key === 'authorization') found.auth = String(v);
      else if (key === 'x-msh-session-id') found.sessionId = String(v);
    };
    if (headers instanceof Headers) {
      read('authorization', headers.get('authorization'));
      read('x-msh-session-id', headers.get('x-msh-session-id'));
    } else if (Array.isArray(headers)) {
      for (const [k, v] of headers) read(String(k), v);
    } else if (headers && typeof headers === 'object') {
      for (const [k, v] of Object.entries(headers as Record<string, unknown>)) read(k, v);
    }
    if (found.auth?.startsWith('Bearer ') && !sniffedAuth.has(site)) sniffedAuth.set(site, found.auth);
    if (found.sessionId && !sniffedSessionId.has(site)) sniffedSessionId.set(site, found.sessionId);
  } catch {
    // ignore
  }
}

/** headers for kimi refetches: sniffed authorization + x-msh-session-id */
function kimiAuthHeaders(auth: string | null): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth) headers.authorization = auth;
  const sessionId = sniffedSessionId.get('kimi');
  if (sessionId) headers['x-msh-session-id'] = sessionId;
  return headers;
}

async function getAuth(site: Site, origFetch: typeof fetch): Promise<string | null> {
  const sniffed = sniffedAuth.get(site);
  if (sniffed) return sniffed;
  try {
    if (site === 'chatgpt') {
      const t = await readChatGptToken(origFetch);
      if (t) return `Bearer ${t}`;
    } else if (site === 'deepseek') {
      const t = readDeepSeekToken();
      if (t) return `Bearer ${t}`;
    } else if (site === 'kimi') {
      const t = readKimiToken();
      if (t) return `Bearer ${t}`;
    }
  } catch {
    // ignore
  }
  return null;
}

function isJsonContentType(ct: string | null): boolean {
  return !!ct && ct.includes('application/json');
}

async function captureJsonPayload(site: Site, data: unknown, extra?: Record<string, unknown>): Promise<void> {
  post({ kind: 'payload', site, pageUrl: location.href, data, ...(extra ?? {}) });
  diag(site, 'captured', location.pathname);
}

async function drainStream(body: ReadableStream<Uint8Array> | null, onChunk?: (text: string) => void): Promise<void> {
  if (!body) return;
  const reader = body.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (onChunk && value) onChunk(dec.decode(value, { stream: true }));
  }
}

// ---------- per-site refetch ----------

async function refetch(site: Site, origFetch: typeof fetch, id: string, org?: string): Promise<void> {
  try {
    if (site === 'chatgpt') {
      const headers: Record<string, string> = {};
      const auth = await getAuth(site, origFetch);
      if (auth) headers.authorization = auth;
      const res = await origFetch(`/backend-api/conversation/${id}`, { credentials: 'include', headers });
      if (res.ok && isJsonContentType(res.headers.get('content-type'))) {
        await captureJsonPayload(site, await res.json());
      } else {
        diag(site, 'error', `refetch ${res.status}`);
      }
      return;
    }
    if (site === 'claude' && org) {
      const res = await origFetch(
        `/api/organizations/${org}/chat_conversations/${id}?tree=True&rendering_mode=messages&render_all_tools=true`,
        { credentials: 'include' },
      );
      if (res.ok && isJsonContentType(res.headers.get('content-type'))) await captureJsonPayload(site, await res.json());
      else diag(site, 'error', `refetch ${res.status}`);
      return;
    }
    if (site === 'deepseek') {
      const headers: Record<string, string> = {};
      const auth = await getAuth(site, origFetch);
      if (auth) headers.authorization = auth;
      const res = await origFetch(`/api/v0/chat/history_messages?chat_session_id=${id}`, {
        credentials: 'include',
        headers,
      });
      if (res.ok && isJsonContentType(res.headers.get('content-type'))) {
        await captureJsonPayload(site, await res.json(), { chatId: id });
      } else {
        diag(site, 'error', `refetch ${res.status}`);
      }
      return;
    }
    if (site === 'kimi') {
      const auth = await getAuth(site, origFetch);
      const headers = kimiAuthHeaders(auth);
      const [listRes, chatRes] = await Promise.all([
        origFetch(`/apiv2/kimi.gateway.chat.v1.ChatService/ListMessages`, {
          method: 'POST',
          credentials: 'include',
          headers,
          body: JSON.stringify({ chat_id: id, page_size: 100 }),
        }),
        origFetch(`/apiv2/kimi.gateway.chat.v1.ChatService/GetChat`, {
          method: 'POST',
          credentials: 'include',
          headers,
          body: JSON.stringify({ chat_id: id }),
        }),
      ]);
      if (listRes.ok && isJsonContentType(listRes.headers.get('content-type'))) {
        let getChat: unknown = null;
        if (chatRes.ok) {
          try {
            getChat = await chatRes.json();
          } catch {
            // title optional
          }
        }
        await captureJsonPayload(site, { listMessages: await listRes.json(), getChat }, { chatId: id });
      } else {
        diag(site, 'error', `refetch ${listRes.status}`);
      }
    }
  } catch (err) {
    diag(site, 'error', err instanceof Error ? err.message.slice(0, 120) : 'refetch failed');
  }
}

// ---------- fetch hook ----------

function onFetchResponse(
  origFetch: typeof fetch,
  site: Site,
  url: string,
  method: string,
  init: RequestInit | undefined,
  res: Response,
): void {
  if (site === 'chatgpt') {
    const direct = CHATGPT_CONVERSATION_RE.exec(url);
    if (direct && method === 'GET' && isJsonContentType(res.headers.get('content-type'))) {
      void res.clone().json().then((d) => void captureJsonPayload(site, d)).catch(() => {});
      return;
    }
    if (method === 'POST' && CHATGPT_STREAM_RE.test(url)) {
      let convId: string | undefined;
      try {
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;
        convId = typeof body.conversation_id === 'string' ? body.conversation_id : undefined;
      } catch {
        // no usable body
      }
      diag(site, 'stream', url);
      void drainStream(res.clone()?.body, (chunk) => {
        if (!convId) {
          const m = /"conversation_id"\s*:\s*"([0-9a-f-]{36})"/.exec(chunk);
          if (m) convId = m[1];
        }
      })
        .then(() => {
          if (convId) return refetch(site, origFetch, convId);
        })
        .catch(() => {});
    }
    return;
  }

  if (site === 'claude') {
    const m = CLAUDE_CONVERSATION_RE.exec(url);
    if (!m) return;
    if (url.includes('/completion')) {
      diag(site, 'stream', url);
    void drainStream(res.clone()?.body)
        .then(() => refetch(site, origFetch, m[2]!, m[1]))
        .catch(() => {});
    } else if (method === 'GET' && isJsonContentType(res.headers.get('content-type'))) {
      void res.clone().json().then((d) => void captureJsonPayload(site, d)).catch(() => {});
    }
    return;
  }

  if (site === 'deepseek') {
    if (DEEPSEEK_STREAM_RE.test(url) && method === 'POST') {
      let convId: string | undefined;
      try {
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;
        convId = typeof body.chat_session_id === 'string' ? body.chat_session_id : undefined;
      } catch {
        // no usable body
      }
      diag(site, 'stream', url);
      void drainStream(res.clone()?.body)
        .then(() => {
          const id = convId ?? DEEPSEEK_PAGE_RE.exec(location.pathname)?.[1];
          if (id) return refetch(site, origFetch, id);
        })
        .catch(() => {});
      return;
    }
    if (method === 'GET' && DEEPSEEK_HISTORY_RE.test(url) && isJsonContentType(res.headers.get('content-type'))) {
      const id = /chat_session_id=([0-9a-f-]{36})/.exec(url)?.[1];
      void res
        .clone()
        .json()
        .then((d) => void captureJsonPayload(site, d, id ? { chatId: id } : {}))
        .catch(() => {});
    }
    return;
  }

  // kimi (apiv2 Connect-RPC)
  if (KIMI_GET_CHAT_RE.test(url) && method === 'POST' && isJsonContentType(res.headers.get('content-type'))) {
    const reqId = kimiChatIdFromBody(init?.body);
    void res
      .clone()
      .json()
      .then((d) => {
        const name = (d as Record<string, unknown> | null)?.chat;
        const title =
          name && typeof name === 'object' ? (name as Record<string, unknown>).name : undefined;
        if (reqId && typeof title === 'string') kimiTitles.set(reqId, title);
      })
      .catch(() => {});
    return;
  }
  if (KIMI_LIST_MESSAGES_RE.test(url)) {
    diag(site, 'lm-branch', `${method}|${res.headers.get('content-type')}`);
  }
  if (KIMI_LIST_MESSAGES_RE.test(url) && method === 'POST' && isJsonContentType(res.headers.get('content-type'))) {
    const chatId = kimiChatIdFromBody(init?.body) ?? KIMI_PAGE_RE.exec(location.pathname)?.[1];
    void res
      .clone()
      .json()
      .then((d) => {
        diag(site, 'lm-json', `ok msgs=${Array.isArray((d as { messages?: unknown[] })?.messages) ? (d as { messages: unknown[] }).messages.length : '?'}`);
        const cached = chatId ? kimiTitles.get(chatId) : undefined;
        return captureJsonPayload(site, { listMessages: d, getChat: cached ? { chat: { name: cached } } : null }, {
          ...(chatId ? { chatId } : {}),
        });
      })
      .catch((e) => diag(site, 'lm-err', String(e).slice(0, 100)));
    return;
  }
  if (KIMI_STREAM_RE.test(url) && method === 'POST') {
    const chatId = kimiChatIdFromBody(init?.body) ?? KIMI_PAGE_RE.exec(location.pathname)?.[1];
    diag(site, 'stream', url);
    void drainStream(res.clone()?.body)
      .then(() => {
        if (chatId) return refetch(site, origFetch, chatId);
      })
      .catch(() => {});
  }
}

function kimiChatIdFromBody(body: unknown): string | undefined {
  try {
    if (typeof body !== 'string') return undefined;
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return typeof parsed.chat_id === 'string' ? parsed.chat_id : undefined;
  } catch {
    return undefined;
  }
}

// ---------- XHR hook (kimi uses XHR for some calls) ----------

interface XhrMeta {
  method: string;
  url: string;
  auth?: string;
  body?: unknown;
}

function installXhrHook(site: Site, origFetch: typeof fetch): void {
  const proto = XMLHttpRequest.prototype as unknown as {
    open: (...args: unknown[]) => unknown;
    send: (...args: unknown[]) => unknown;
    setRequestHeader: (k: string, v: string) => unknown;
    __omc?: XhrMeta;
  };
  const origOpen = proto.open;
  const origSend = proto.send;
  const origSetHeader = proto.setRequestHeader;

  proto.open = function (this: XMLHttpRequest & { __omc?: XhrMeta }, ...args: unknown[]) {
    this.__omc = { method: String(args[0] ?? 'GET').toUpperCase(), url: String(args[1] ?? '') };
    return origOpen.apply(this, args as never) as never;
  };
  proto.setRequestHeader = function (this: XMLHttpRequest & { __omc?: XhrMeta }, k: string, v: string) {
    try {
      const key = k.toLowerCase();
      if (this.__omc && key === 'authorization' && v.startsWith('Bearer ') && !sniffedAuth.has(site)) {
        sniffedAuth.set(site, v);
      } else if (this.__omc && key === 'x-msh-session-id' && !sniffedSessionId.has(site)) {
        sniffedSessionId.set(site, v);
      }
    } catch {
      // ignore
    }
    return origSetHeader.call(this, k, v) as never;
  };
  proto.send = function (this: XMLHttpRequest & { __omc?: XhrMeta }, ...args: unknown[]) {
    const meta = this.__omc;
    if (meta) {
      meta.body = args[0];
      try {
        const url = meta.url;
        const isApi =
          CHATGPT_STREAM_RE.test(url) ||
          CLAUDE_CONVERSATION_RE.test(url) ||
          DEEPSEEK_STREAM_RE.test(url) ||
          DEEPSEEK_HISTORY_RE.test(url) ||
          KIMI_LIST_MESSAGES_RE.test(url) ||
          KIMI_GET_CHAT_RE.test(url) ||
          KIMI_STREAM_RE.test(url);
        if (isApi) diag(site, 'request', `xhr ${meta.method} ${url}`);
        if (KIMI_LIST_MESSAGES_RE.test(url) && meta.method === 'POST') {
          const chatId = kimiChatIdFromBody(meta.body) ?? KIMI_PAGE_RE.exec(location.pathname)?.[1];
          this.addEventListener('load', () => {
            try {
              const d = JSON.parse((this as XMLHttpRequest).responseText);
              const cached = chatId ? kimiTitles.get(chatId) : undefined;
              void captureJsonPayload(site, { listMessages: d, getChat: cached ? { chat: { name: cached } } : null }, {
                ...(chatId ? { chatId } : {}),
              });
            } catch {
              // not json
            }
          });
        } else if (KIMI_GET_CHAT_RE.test(url) && meta.method === 'POST') {
          const reqId = kimiChatIdFromBody(meta.body);
          this.addEventListener('load', () => {
            try {
              const d = JSON.parse((this as XMLHttpRequest).responseText) as Record<string, unknown>;
              const chat = d?.chat as Record<string, unknown> | undefined;
              if (reqId && typeof chat?.name === 'string') kimiTitles.set(reqId, chat.name);
            } catch {
              // not json
            }
          });
        } else if (KIMI_STREAM_RE.test(url) && meta.method === 'POST') {
          const chatId = kimiChatIdFromBody(meta.body) ?? KIMI_PAGE_RE.exec(location.pathname)?.[1];
          this.addEventListener('loadend', () => {
            if (chatId) void refetch(site, origFetch, chatId);
          });
        }
      } catch {
        // never break the host page
      }
    }
    return origSend.apply(this, args as never) as never;
  };
}

// ---------- install ----------

function install(): void {
  const w = window as unknown as { __omcHooked?: boolean };
  if (w.__omcHooked) return;
  w.__omcHooked = true;
  const site = currentSite();
  if (!site) return;
  // heartbeat: lets the popup's Diagnostics tab prove the hook is alive on this host
  diag(site, 'hook-active', location.hostname);
  const origFetch = window.fetch.bind(window);

  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await origFetch(input, init);
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = (
        init?.method ??
        (typeof input === 'object' && 'method' in input ? input.method : 'GET')
      ).toUpperCase();
      const headers = init?.headers ?? (typeof input === 'object' && 'headers' in input ? input.headers : undefined);
      if (
        CHATGPT_STREAM_RE.test(url) ||
        CHATGPT_CONVERSATION_RE.test(url) ||
        CLAUDE_CONVERSATION_RE.test(url) ||
        DEEPSEEK_STREAM_RE.test(url) ||
        DEEPSEEK_HISTORY_RE.test(url) ||
        KIMI_LIST_MESSAGES_RE.test(url) ||
        KIMI_GET_CHAT_RE.test(url) ||
        KIMI_STREAM_RE.test(url)
      ) {
        sniffAuth(site, headers);
        diag(site, 'request', `${method} ${url}`);
        onFetchResponse(origFetch, site, url, method, init, res);
      }
    } catch {
      // never break the host page
    }
    return res;
  }) as typeof fetch;

  try {
    installXhrHook(site, origFetch);
  } catch {
    // ignore
  }
}

export default defineContentScript({
  matches: [
    '*://chatgpt.com/*',
    '*://claude.ai/*',
    '*://chat.deepseek.com/*',
    '*://kimi.com/*',
    '*://*.kimi.com/*',
    '*://kimi.moonshot.cn/*',
    '*://*.kimi.moonshot.cn/*',
  ],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    try {
      install();
    } catch {
      // never break the host page
    }
  },
});
