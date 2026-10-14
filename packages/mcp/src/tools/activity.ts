import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OmcStore } from '@ohmycontext/core';
import { oneLine } from './common.js';

export function registerRecentActivity(server: McpServer, store: OmcStore): void {
  server.registerTool(
    'recent_activity',
    {
      title: 'Recent activity',
      description:
        'Sessions touched within the last N minutes, with a one-line preview of the latest message. Good for "what did my coding agents do recently?"',
      inputSchema: {
        minutes: z
          .number()
          .int()
          .min(1)
          .max(525600)
          .default(60)
          .describe('look-back window in minutes (max 1 year)'),
        source: z.string().optional().describe("restrict to one source, e.g. 'claude-code' or 'codex'"),
        limit: z.number().int().min(1).max(100).default(20),
      },
    },
    async ({ minutes, source, limit }) => {
      const since = new Date(Date.now() - minutes * 60_000).toISOString();
      const { sessions, total } = store.recentSessions({
        since,
        ...(source ? { source } : {}),
        limit,
      });
      const header =
        total === 0
          ? `No sessions active in the last ${minutes} minute(s).`
          : `${total} session(s) active in the last ${minutes} minute(s)${total > sessions.length ? ` — showing latest ${sessions.length}` : ''}:`;
      const lines = sessions.map((s) => {
        const label = oneLine(s.title ?? s.cwd ?? s.externalId, 60);
        const preview = s.lastMessagePreview ? oneLine(s.lastMessagePreview, 120) : '';
        return `${s.lastActivity.slice(0, 16).replace('T', ' ')}Z  ${s.source}  ${s.messageCount} msgs  ${label}  | last ${s.lastMessageRole ?? '?'}: ${preview}  [${s.id.slice(0, 8)}]`;
      });
      return {
        content: [
          { type: 'text' as const, text: [header, ...lines].join('\n') },
          {
            type: 'text' as const,
            text: JSON.stringify({ total, returned: sessions.length, truncated: total > sessions.length }),
          },
        ],
      };
    },
  );
}
