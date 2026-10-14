import { defineContentScript } from 'wxt/utils/define-content-script';

// Runs in the page's MAIN world and monkey-patches window.fetch to observe the
// site's own backend API traffic. Everything is wrapped in try/catch: capture
// must never break the host page.

const CHATGPT_CONVERSATION_RE = /\/backend-api\/conversation\/([0-9a-f-]{36})/;
const CHATGPT_STREAM_RE = /\/backend-api\/conversation\/?(\?|$)/;
const CLAUDE_CONVERSATION_RE = /\/api\/organizations\/([^/?]+)\/chat_conversations\/([0-9a-f-]{36})/;

type Site = 'chatgpt' | 'claude';

function install(): void {
  const w = window as unknown as { __omcHooked?: boolean; fetch: typeof fetch };
  if (w.__omcHooked) return;
  w.__omcHooked = true;
  const origFetch = window.fetch.bind(window);

  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await origFetch(input, init);
    try {
      onResponse(origFetch, input, init, res);
    } catch {
      // never break the host page
    }
    return res;
  }) as typeof fetch;
}

function site(): Site | null {
  const h = location.hostname;
  if (h === 'chatgpt.com' || h.endsWith('.chatgpt.com')) return 'chatgpt';
  if (h === 'claude.ai' || h.endsWith('.claude.ai')) return 'claude';
  return null;
}

function isJson(res: Response): boolean {
  try {
    return (res.headers.get('content-type') ?? '').includes('application/json');
  } catch {
    return false;
  }
}

function postToBridge(siteName: Site, data: unknown): void {
  try {
    window.postMessage({ source: 'omc-pagehook', site: siteName, pageUrl: location.href, data }, location.origin);
  } catch {
    // ignore
  }
}

async function captureJson(res: Response, siteName: Site): Promise<void> {
  try {
    postToBridge(siteName, await res.json());
  } catch {
    // ignore
  }
}

async function drainStream(res: Response, onChunk?: (text: string) => void): Promise<void> {
  try {
    const reader = res.body?.getReader();
    if (!reader) return;
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (onChunk && value) onChunk(dec.decode(value, { stream: true }));
    }
  } catch {
    // stream aborted mid-read; nothing to do
  }
}

async function refetchConversation(
  origFetch: typeof fetch,
  siteName: Site,
  url: string,
): Promise<void> {
  try {
    const res = await origFetch(url, { credentials: 'include' });
    if (res.ok && isJson(res)) await captureJson(res, siteName);
  } catch {
    // offline / logged out / rate-limited: skip silently
  }
}

function onResponse(
  origFetch: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  res: Response,
): void {
  const s = site();
  if (!s) return;
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();

  if (s === 'chatgpt') {
    const direct = CHATGPT_CONVERSATION_RE.exec(url);
    if (direct && method === 'GET' && isJson(res)) {
      void captureJson(res.clone(), s);
      return;
    }
    // streaming completion POST: when the SSE stream ends, refetch final state
    if (method === 'POST' && CHATGPT_STREAM_RE.test(url)) {
      let convId: string | undefined;
      try {
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;
        convId = typeof body.conversation_id === 'string' ? body.conversation_id : undefined;
      } catch {
        // no usable body
      }
      void drainStream(res.clone(), (chunk) => {
        if (!convId) {
          const m = /"conversation_id"\s*:\s*"([0-9a-f-]{36})"/.exec(chunk);
          if (m) convId = m[1];
        }
      }).then(() => {
        if (convId) return refetchConversation(origFetch, s, `/backend-api/conversation/${convId}`);
      });
    }
    return;
  }

  const m = CLAUDE_CONVERSATION_RE.exec(url);
  if (!m) return;
  const [, org, convId] = m;
  if (url.includes('/completion')) {
    // streaming completion: refetch the full conversation once the stream ends
    void drainStream(res.clone()).then(() =>
      refetchConversation(origFetch, s, `/api/organizations/${org}/chat_conversations/${convId}?tree=True&rendering_mode=messages&render_all_tools=true`),
    );
  } else if (method === 'GET' && isJson(res)) {
    void captureJson(res.clone(), s);
  }
}

export default defineContentScript({
  matches: ['*://chatgpt.com/*', '*://claude.ai/*'],
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
