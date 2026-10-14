import { Hono } from 'hono';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { OMC_VERSION, type OmcStore } from '@ohmycontext/core';
import { createMcpServer } from '@ohmycontext/mcp';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const EXTENSION_ORIGIN_RE = /^(chrome|moz|safari-web)-extension:\/\//;

/**
 * Loopback binding alone is not a security boundary: any website open in the
 * user's browser could otherwise POST to us cross-origin (simple requests
 * skip preflight) or read responses via DNS rebinding. Policy:
 *  - Host header must be 127.0.0.1 / localhost (optionally with our port) —
 *    defeats DNS rebinding.
 *  - Requests without an Origin header (curl, node, MCP clients, tunnels) pass.
 *  - Requests with an Origin header must be a browser-extension origin —
 *    all other browser origins get 403 on every route.
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
  if (originHeader !== undefined && !EXTENSION_ORIGIN_RE.test(originHeader)) return false;
  return true;
}

function isAllowedContentType(ct: string | undefined): boolean {
  const base = ct?.split(';', 1)[0]?.trim().toLowerCase();
  return base === 'application/json' || base === 'application/x-ndjson';
}

export function createApp(deps: { store: OmcStore; startedAt: number; port: number }): Hono {
  const { store, startedAt, port } = deps;
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
    const afterSeq = q.after_seq !== undefined ? Number(q.after_seq) : undefined;
    const limit = q.limit !== undefined ? Number(q.limit) : undefined;
    if ((afterSeq !== undefined && !Number.isFinite(afterSeq)) || (limit !== undefined && !Number.isFinite(limit))) {
      return c.json({ error: 'after_seq and limit must be numbers' }, 400);
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
