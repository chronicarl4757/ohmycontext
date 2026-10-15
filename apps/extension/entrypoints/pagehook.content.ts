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
const DEEPSEEK_PAGE_RE = /\/(?:a\/)?chat\/s\/([0-9a-f-]{36})/;
const KIMI_SCROLL_RE = /\/api\/chat\/([0-9a-f-]{36})\/segment\/scroll/;
const KIMI_STREAM_RE = /\/api\/chat\/([0-9a-f-]{36})\/completion\/stream/;
const KIMI_INFO_RE = /\/api\/chat\/([0-9a-f-]{36})(?:\?|$)/;

const sniffedAuth = new Map<Site, string>();

function currentSite(): Site | null {
  return HOST_SITE[location.hostname] ?? null;
}

function post(payload: Record<string, unknown>): void {
  try {
    window.postMessage({ source: 'omc-pagehook', ...payload }, location.origin);
  } catch {
    // ignore
  }
}

function diag(site: Site, event: 'request' | 'captured' | 'error', detail: string): void {
  const redacted = detail
    .split('/')
    .map((seg) => (seg.length > 12 ? `${seg.slice(0, 8)}…` : seg))
    .join('/')
    .slice(0, 160);
  post({ kind: 'diag', site, event, detail: redacted });
}

function sniffAuth(site: Site, headers: unknown): void {
  try {
    let auth: string | null = null;
    if (headers instanceof Headers) auth = headers.get('authorization');
    else if (Array.isArray(headers)) {
      for (const [k, v] of headers) if (String(k).toLowerCase() === 'authorization') auth = String(v);
    } else if (headers && typeof headers === 'object') {
      for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
        if (k.toLowerCase() === 'authorization') auth = String(v);
      }
    }
    if (auth && auth.startsWith('Bearer ') && !sniffedAuth.has(site)) sniffedAuth.set(site, auth);
  } catch {
    // ignore
  }
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
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      const auth = await getAuth(site, origFetch);
      if (auth) headers.authorization = auth;
      const [scroll, info] = await Promise.all([
        origFetch(`/api/chat/${id}/segment/scroll`, {
          method: 'POST',
          credentials: 'include',
          headers,
          body: JSON.stringify({ last: 1000 }),
        }),
        origFetch(`/api/chat/${id}`, { credentials: 'include', headers }),
      ]);
      if (scroll.ok) {
        const data = await scroll.json();
        let title: string | undefined;
        if (info.ok) {
          try {
            const meta = (await info.json()) as Record<string, unknown>;
            title = typeof meta.name === 'string' ? meta.name : undefined;
          } catch {
            // title optional
          }
        }
        await captureJsonPayload(site, data, { chatId: id, ...(title ? { title } : {}) });
      } else {
        diag(site, 'error', `refetch ${scroll.status}`);
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

  // kimi
  const scroll = KIMI_SCROLL_RE.exec(url);
  if (scroll && method === 'POST' && isJsonContentType(res.headers.get('content-type'))) {
    const id = scroll[1]!;
    void res
      .clone()
      .json()
      .then((d) => void captureJsonPayload(site, d, { chatId: id }))
      .catch(() => {});
    return;
  }
  const stream = KIMI_STREAM_RE.exec(url);
  if (stream && method === 'POST') {
    const id = stream[1]!;
    void drainStream(res.clone()?.body)
      .then(() => refetch(site, origFetch, id))
      .catch(() => {});
  }
}

// ---------- XHR hook (kimi uses XHR for some calls) ----------

interface XhrMeta {
  method: string;
  url: string;
  auth?: string;
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
      if (this.__omc && k.toLowerCase() === 'authorization' && v.startsWith('Bearer ') && !sniffedAuth.has(site)) {
        sniffedAuth.set(site, v);
      }
    } catch {
      // ignore
    }
    return origSetHeader.call(this, k, v) as never;
  };
  proto.send = function (this: XMLHttpRequest & { __omc?: XhrMeta }, ...args: unknown[]) {
    const meta = this.__omc;
    if (meta) {
      try {
        const url = meta.url;
        const isApi =
          CHATGPT_STREAM_RE.test(url) ||
          CLAUDE_CONVERSATION_RE.test(url) ||
          DEEPSEEK_STREAM_RE.test(url) ||
          DEEPSEEK_HISTORY_RE.test(url) ||
          KIMI_SCROLL_RE.test(url) ||
          KIMI_STREAM_RE.test(url);
        if (isApi) diag(site, 'request', `xhr ${meta.method} ${url}`);
        const scroll = KIMI_SCROLL_RE.exec(url);
        const stream = KIMI_STREAM_RE.exec(url);
        if (scroll && meta.method === 'POST') {
          const id = scroll[1]!;
          this.addEventListener('load', () => {
            try {
              captureJsonPayload(site, JSON.parse((this as XMLHttpRequest).responseText), { chatId: id });
            } catch {
              // not json
            }
          });
        } else if (stream && meta.method === 'POST') {
          const id = stream[1]!;
          this.addEventListener('loadend', () => {
            void refetch(site, origFetch, id);
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
        KIMI_SCROLL_RE.test(url) ||
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
