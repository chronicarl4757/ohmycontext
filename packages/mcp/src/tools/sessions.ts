import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OmcStore, Role } from '@ohmycontext/core';
import { errorContent, jsonContent } from './common.js';

const MAX_MESSAGE_CONTENT = 8000;

export function registerListSessions(server: McpServer, store: OmcStore): void {
  server.registerTool(
    'list_sessions',
    {
      title: 'List sessions',
      description: 'List captured AI sessions, most recent first, with message counts.',
      inputSchema: {
        source: z.string().optional().describe("restrict to one source, e.g. 'claude-code' or 'codex'"),
        since: z.string().optional().describe('ISO-8601 lower bound on session start'),
        until: z.string().optional().describe('ISO-8601 upper bound on session start'),
        limit: z.number().int().min(1).max(100).default(20),
        offset: z.number().int().min(0).default(0),
      },
    },
    async ({ source, since, until, limit, offset }) => {
      const opts = {
        ...(source ? { source } : {}),
        ...(since ? { since } : {}),
        ...(until ? { until } : {}),
        limit,
        offset,
      };
      const sessions = store.listSessions(opts);
      const total = store.sessionCount(opts);
      return jsonContent({
        total,
        returned: sessions.length,
        offset,
        truncated: offset + sessions.length < total,
        sessions: sessions.map((s) => ({
          id: s.id,
          source: s.source,
          title: s.title ?? null,
          cwd: s.cwd ?? null,
          startedAt: s.startedAt,
          endedAt: s.endedAt ?? null,
          model: s.model ?? null,
          messageCount: s.messageCount,
        })),
      });
    },
  );
}

export function registerGetSession(server: McpServer, store: OmcStore): void {
  server.registerTool(
    'get_session',
    {
      title: 'Get session messages',
      description:
        'Fetch messages of one session in chronological order. Long message contents are capped and flagged with truncated: true.',
      inputSchema: {
        sessionId: z.string().describe('full session id or a unique prefix'),
        limit: z.number().int().min(1).max(500).default(50),
        offset: z.number().int().min(0).default(0),
        roles: z
          .array(z.enum(['user', 'assistant', 'system', 'tool']))
          .optional()
          .describe('keep only these roles'),
      },
    },
    async ({ sessionId, limit, offset, roles }) => {
      const id = store.resolveSessionId(sessionId);
      if (!id) return errorContent(`session not found or prefix ambiguous: ${sessionId}`);
      const filter = { sessionId: id, ...(roles ? { roles: roles as Role[] } : {}) };
      const total = store.messageCount(filter);
      const messages = store.getMessages({ ...filter, limit, offset });
      const session = store.getSessions({ sessionId: id })[0] ?? null;
      return jsonContent({
        session,
        total,
        returned: messages.length,
        offset,
        truncated: offset + messages.length < total,
        messages: messages.map((m) => ({
          id: m.id,
          role: m.role,
          contentType: m.contentType,
          createdAt: m.createdAt,
          content:
            m.content.length > MAX_MESSAGE_CONTENT
              ? `${m.content.slice(0, MAX_MESSAGE_CONTENT)}…`
              : m.content,
          truncated: m.content.length > MAX_MESSAGE_CONTENT,
          ...(m.model ? { model: m.model } : {}),
          ...(m.tokenUsage ? { tokenUsage: m.tokenUsage } : {}),
          ...(m.parentId ? { parentId: m.parentId } : {}),
        })),
      });
    },
  );
}
