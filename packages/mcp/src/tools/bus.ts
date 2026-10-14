import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BusMessage, OmcStore } from '@ohmycontext/core';
import { jsonContent } from './common.js';

const POLL_MS = 500;
const MAX_WAIT_SEC = 60;

function busMessageToJson(m: BusMessage): Record<string, unknown> {
  return {
    seq: m.seq,
    id: m.id,
    channel: m.channel,
    sender: m.sender,
    content: m.content,
    ...(m.refs ? { refs: m.refs } : {}),
    createdAt: m.createdAt,
  };
}

export function registerBusPost(server: McpServer, store: OmcStore): void {
  server.registerTool(
    'bus_post',
    {
      title: 'Post to message bus',
      description:
        'Leave a message for other agents on a free-form channel (channels are conventions — e.g. "review", "tasks", your project name). Always post with a stable sender name (your agent id, e.g. "codex" or "claude-code") so replies can find you. Pass a clientMsgId for idempotent retries. Read replies with bus_read/bus_wait on the same channel.',
      inputSchema: {
        channel: z.string().min(1).max(200),
        sender: z.string().min(1).max(200).describe('your stable agent name'),
        content: z.string().min(1).max(100_000),
        refs: z.array(z.string()).optional().describe('session ids / artifact paths being discussed'),
        clientMsgId: z.string().optional().describe('idempotency key; reposts with the same key are dropped'),
      },
    },
    async ({ channel, sender, content, refs, clientMsgId }) => {
      const res = store.postBusMessage({
        channel,
        sender,
        content,
        ...(refs ? { refs } : {}),
        ...(clientMsgId ? { clientMsgId } : {}),
      });
      return jsonContent(res);
    },
  );
}

export function registerBusRead(server: McpServer, store: OmcStore): void {
  server.registerTool(
    'bus_read',
    {
      title: 'Read from message bus',
      description:
        'Read messages from a bus channel (or all channels). Cursor-based: keep the returned latestSeq and pass it as afterSeq next time to get only new messages. Use bus_wait instead when you want to block until something arrives.',
      inputSchema: {
        channel: z.string().optional().describe('omit to read across all channels'),
        afterSeq: z.number().int().min(0).optional().describe('only messages with seq > this cursor'),
        since: z.string().optional().describe('ISO-8601 lower bound on message time'),
        limit: z.number().int().min(1).max(500).default(100),
      },
    },
    async ({ channel, afterSeq, since, limit }) => {
      const { messages, latestSeq, truncated } = store.readBusMessages({
        ...(channel ? { channel } : {}),
        ...(afterSeq !== undefined ? { afterSeq } : {}),
        ...(since ? { since } : {}),
        limit,
      });
      return jsonContent({
        messages: messages.map(busMessageToJson),
        latestSeq,
        truncated,
      });
    },
  );
}

export function registerBusWait(server: McpServer, store: OmcStore, shutdown: AbortSignal): void {
  server.registerTool(
    'bus_wait',
    {
      title: 'Wait for bus messages (long-poll)',
      description:
        'Block server-side until a new message arrives on a channel (or timeoutSec elapses) — the efficient way to wait for another agent’s reply: call with your remembered latestSeq as afterSeq, then reply with bus_post and wait again. Returns timedOut: true when nothing arrived. Note: if your client has a scheduler/cron, polling this on a cadence gives near-realtime relay.',
      inputSchema: {
        channel: z.string(),
        afterSeq: z.number().int().min(0).optional().describe('your remembered cursor (latestSeq from last read)'),
        timeoutSec: z.number().int().min(1).max(MAX_WAIT_SEC).default(25),
      },
    },
    async ({ channel, afterSeq, timeoutSec }) => {
      const deadline = Date.now() + timeoutSec * 1000;
      for (;;) {
        const { messages, latestSeq, truncated } = store.readBusMessages({
          channel,
          ...(afterSeq !== undefined ? { afterSeq } : {}),
          limit: 500,
        });
        if (messages.length > 0) {
          return jsonContent({ messages: messages.map(busMessageToJson), latestSeq, truncated, timedOut: false });
        }
        if (Date.now() >= deadline || shutdown.aborted) {
          return jsonContent({ messages: [], latestSeq, truncated: false, timedOut: true });
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    },
  );
}

export function registerBusChannels(server: McpServer, store: OmcStore): void {
  server.registerTool(
    'bus_channels',
    {
      title: 'List bus channels',
      description: 'List all bus channels with message counts, last activity, and known senders.',
      inputSchema: {},
    },
    async () => jsonContent({ channels: store.listBusChannels() }),
  );
}
