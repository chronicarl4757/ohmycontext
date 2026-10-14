import { Hono } from 'hono';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OMC_VERSION, type OmcStore } from '@ohmycontext/core';
import { createMcpServer } from '@ohmycontext/mcp';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const EXTENSION_ORIGIN_RE = /^(chrome|moz|safari-web)-extension:\/\//;

function isOwnOrigin(origin: string, port: number): boolean {
  const m = /^https?:\/\/(127\.0\.0\.1|localhost)(?::(\d+))?$/.exec(origin);
  if (!m) return false;
  return m[2] === undefined || Number(m[2]) === port;
}

/**
 * Loopback binding alone is not a security boundary: any website open in the
 * user's browser could otherwise POST to us cross-origin (simple requests
 * skip preflight) or read responses via DNS rebinding. Policy:
 *  - Host header must be 127.0.0.1 / localhost (optionally with our port) —
 *    defeats DNS rebinding.
 *  - Requests without an Origin header (curl, node, MCP clients, tunnels) pass.
 *  - Requests with an Origin header must be a browser-extension origin or the
 *    daemon's own web UI origin — all other browser origins get 403.
 *  - POST bodies must be application/json or application/x-ndjson, which
 *    browsers cannot send cross-origin without a preflight we would reject.
 */
export function isAllowedLocalRequest(
  hostHeader: string | undefined,
  originHeader: string | undefined,
  port: number,
): boolean {
  if (!hostHeader) return false;
  const hostname = hostHeader.replace(/:\d+$/, '').toLowerCase();
  if (hostname !== '127.0.0.1' && hostname !== 'localhost') return false;
  const portPart = hostHeader.includes(':') ? Number(hostHeader.split(':').pop()) : null;
  if (portPart !== null && portPart !== port) return false;
  if (
    originHeader !== undefined &&
    !EXTENSION_ORIGIN_RE.test(originHeader) &&
    !isOwnOrigin(originHeader, port)
  ) {
    return false;
  }
  return true;
}

function isAllowedContentType(ct: string | undefined): boolean {
  const base = ct?.split(';', 1)[0]?.trim().toLowerCase();
  return base === 'application/json' || base === 'application/x-ndjson';
}

function intParam(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
};

export function resolveWebDir(): string | null {
  const candidates: string[] = [];
  if (process.env.OMC_WEB_DIR) candidates.push(process.env.OMC_WEB_DIR);
  try {
    // both packages/daemon/dist/index.js and the bundled apps/cli/dist/index.js
    // sit at <pkg>/dist/index.js, three levels below the repo root
    candidates.push(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'apps', 'web', 'dist'));
  } catch {
    // import.meta unavailable; cwd candidate below still applies
  }
  candidates.push(join(process.cwd(), 'apps', 'web', 'dist'));
  for (const dir of candidates) {
    if (existsSync(join(dir, 'index.html'))) return dir;
  }
  return null;
}

export function createApp(deps: { store: OmcStore; startedAt: number; port: number }): Hono {
  const { store, startedAt, port } = deps;
  const webDir = resolveWebDir();
  const app = new Hono();

  app.use('*', async (c, next) => {
    const origin = c.req.header('origin');
    if (!isAllowedLocalRequest(c.req.header('host'), origin, port)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    if (c.req.method === 'OPTIONS') {
      const headers: Record<string, string> = {
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-max-age': '86400',
      };
      if (origin) {
        headers['access-control-allow-origin'] = origin;
        headers['access-control-allow-headers'] = 'content-type';
        headers['vary'] = 'Origin';
      }
      return new Response(null, { status: 204, headers });
    }
    await next();
    if (origin) {
      c.header('access-control-allow-origin', origin);
      c.header('vary', 'Origin');
    }
  });

  app.post('/bus/post', async (c) => {
    if (!isAllowedContentType(c.req.header('content-type'))) {
      return c.json({ error: 'content-type must be application/json or application/x-ndjson' }, 415);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const payload = body as Record<string, unknown>;
    if (
      typeof payload?.channel !== 'string' ||
      typeof payload?.sender !== 'string' ||
      typeof payload?.content !== 'string' ||
      !payload.channel ||
      !payload.sender ||
      !payload.content
    ) {
      return c.json({ error: 'channel, sender and content are required strings' }, 400);
    }
    if (
      payload.refs !== undefined &&
      (!Array.isArray(payload.refs) || payload.refs.some((r) => typeof r !== 'string'))
    ) {
      return c.json({ error: 'refs must be a string array' }, 400);
    }
    if (payload.clientMsgId !== undefined && typeof payload.clientMsgId !== 'string') {
      return c.json({ error: 'clientMsgId must be a string' }, 400);
    }
    const res = store.postBusMessage({
      channel: payload.channel,
      sender: payload.sender,
      content: payload.content,
      ...(Array.isArray(payload.refs) ? { refs: payload.refs as string[] } : {}),
      ...(typeof payload.clientMsgId === 'string' ? { clientMsgId: payload.clientMsgId } : {}),
    });
    return c.json(res);
  });

  app.get('/bus/read', (c) => {
    const q = c.req.query();
    const afterSeq = intParam(q.after_seq);
    const limit = intParam(q.limit);
    if ((q.after_seq !== undefined && afterSeq === undefined) || (q.limit !== undefined && limit === undefined)) {
      return c.json({ error: 'after_seq and limit must be non-negative numbers' }, 400);
    }
    const { messages, latestSeq, truncated } = store.readBusMessages({
      ...(q.channel ? { channel: q.channel } : {}),
      ...(afterSeq !== undefined ? { afterSeq } : {}),
      ...(q.since ? { since: q.since } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return c.json({ messages, latestSeq, truncated });
  });

  app.get('/bus/channels', (c) => c.json({ channels: store.listBusChannels() }));

  app.get('/health', (c) =>
    c.json({ ok: true, version: OMC_VERSION, uptimeSec: Math.floor((Date.now() - startedAt) / 1000) }),
  );

  app.get('/stats', (c) => c.json(store.stats()));

  app.post('/ingest', async (c) => {
    if (!isAllowedContentType(c.req.header('content-type'))) {
      return c.json({ error: 'content-type must be application/json or application/x-ndjson' }, 415);
    }
    const body = await c.req.text();
    const lines = body.split('\n').filter((l) => l.trim().length > 0);
    const events: unknown[] = [];
    const errors: { index: number; error: string }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      try {
        events.push(JSON.parse(line));
      } catch (err) {
        errors.push({ index: i, error: err instanceof Error ? err.message : String(err) });
      }
    }
    const res = store.ingest(events);
    return c.json({
      ingested: res.ingested,
      skipped: res.skipped,
      unknown: res.unknown,
      errors: [...errors, ...res.errors],
    });
  });

  // --- read-only JSON API for the web UI (mirrors the MCP tool shapes) ---

  app.get('/api/overview', (c) => c.json(store.stats()));

  app.get('/api/activity', (c) => {
    const minutes = intParam(c.req.query('minutes')) ?? 60;
    const limit = intParam(c.req.query('limit')) ?? 20;
    const since = new Date(Date.now() - minutes * 60_000).toISOString();
    return c.json(store.recentSessions({ since, limit }));
  });

  app.get('/api/sessions', (c) => {
    const q = c.req.query();
    const limit = intParam(q.limit) ?? 50;
    const offset = intParam(q.offset) ?? 0;
    const opts = { ...(q.source ? { source: q.source } : {}), limit, offset };
    return c.json({ sessions: store.listSessions(opts), total: store.sessionCount(opts) });
  });

  app.get('/api/sessions/:id', (c) => {
    const id = store.resolveSessionId(c.req.param('id'));
    if (!id) return c.json({ error: 'session not found or prefix ambiguous' }, 404);
    const limit = intParam(c.req.query('limit')) ?? 200;
    const offset = intParam(c.req.query('offset')) ?? 0;
    const session = store.getSessions({ sessionId: id })[0] ?? null;
    const messages = store.getMessages({ sessionId: id, limit, offset });
    const total = store.messageCount({ sessionId: id });
    const artifacts = store.getArtifacts({ sessionId: id, limit: 500 });
    return c.json({ session, messages, total, artifacts });
  });

  app.get('/api/search', (c) => {
    const q = c.req.query('q') ?? '';
    if (!q.trim()) return c.json({ hits: [], total: 0 });
    const source = c.req.query('source');
    const limit = intParam(c.req.query('limit')) ?? 50;
    const offset = intParam(c.req.query('offset')) ?? 0;
    const opts = { ...(source ? { source } : {}), limit, offset };
    const hits = store.search(q, opts);
    const total = hits.length >= limit ? store.countSearch(q, opts) : hits.length + offset;
    return c.json({
      hits: hits.map((h) => ({
        messageId: h.id,
        sessionId: h.sessionId,
        source: h.source,
        role: h.role,
        createdAt: h.createdAt,
        snippet: h.snippet.replace(/\s+/g, ' ').trim(),
        sessionTitle: h.title,
        sessionCwd: h.cwd,
      })),
      total,
    });
  });

  app.get('/api/artifacts', (c) => {
    const q = c.req.query();
    const kind = q.kind;
    if (kind !== undefined && !['file', 'url', 'image', 'other'].includes(kind)) {
      return c.json({ error: 'kind must be file|url|image|other' }, 400);
    }
    const filter = {
      ...(kind ? { kind: kind as 'file' | 'url' | 'image' | 'other' } : {}),
      ...(q.pathPrefix ? { pathPrefix: q.pathPrefix } : {}),
    };
    const limit = intParam(q.limit) ?? 50;
    const offset = intParam(q.offset) ?? 0;
    return c.json({
      artifacts: store.getArtifacts({ ...filter, limit, offset }),
      total: store.artifactCount(filter),
    });
  });

  app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

  // --- static web UI (everything else); never shadows the routes above ---

  app.get('*', async (c) => {
    if (!webDir) return c.text('web UI not built: run pnpm build', 404);
    const urlPath = decodeURIComponent(new URL(c.req.url).pathname);
    let rel = normalize(urlPath).replace(/^([/\\])+/, '');
    if (rel === '' || rel === '.') rel = 'index.html';
    let filePath = join(webDir, rel);
    if (!filePath.startsWith(webDir)) return c.text('forbidden', 403);
    if (!existsSync(filePath) || !statSync(filePath).isFile()) filePath = join(webDir, 'index.html');
    try {
      const buf = await readFile(filePath);
      const isHtml = filePath.endsWith('.html');
      return new Response(buf, {
        headers: {
          'content-type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
          'cache-control': isHtml ? 'no-cache' : 'public, max-age=31536000, immutable',
        },
      });
    } catch {
      return c.text('not found', 404);
    }
  });

  return app;
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolvePromise(undefined);
      }
    });
    req.on('error', () => resolvePromise(undefined));
  });
}

/**
 * Stateless streamable-HTTP MCP endpoint: a fresh server+transport per request
 * keeps this trivially safe alongside the watcher's concurrent DB writes.
 */
export async function handleMcpHttp(
  store: OmcStore,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const server = createMcpServer({ store });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    const body = req.method === 'POST' ? await readJsonBody(req) : undefined;
    await transport.handleRequest(req, res, body);
  } catch {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    if (!res.writableEnded) {
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null }));
    }
  }
}
