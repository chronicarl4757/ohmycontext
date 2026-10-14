import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OmcStore } from '@ohmycontext/core';
import { jsonContent } from './common.js';

export function registerSearchContext(server: McpServer, store: OmcStore): void {
  server.registerTool(
    'search_context',
    {
      title: 'Search context',
      description:
        'Full-text search over every captured AI conversation (all tools/sources). Returns ranked hits with snippets and the session each belongs to.',
      inputSchema: {
        query: z.string().describe('search terms; whitespace-separated words are ANDed'),
        source: z.string().optional().describe("restrict to one source, e.g. 'claude-code' or 'codex'"),
        since: z.string().optional().describe('ISO-8601 lower bound on message timestamp'),
        until: z.string().optional().describe('ISO-8601 upper bound on message timestamp'),
        limit: z.number().int().min(1).max(100).default(20).describe('max hits to return'),
      },
    },
    async ({ query, source, since, until, limit }) => {
      const opts = {
        ...(source ? { source } : {}),
        ...(since ? { since } : {}),
        ...(until ? { until } : {}),
        limit,
      };
      const hits = store.search(query, opts);
      // the count query only runs when the page looks full
      const total = hits.length >= limit ? store.countSearch(query, opts) : hits.length;
      return jsonContent({
        total,
        returned: hits.length,
        truncated: total > hits.length,
        hits: hits.map((h) => ({
          messageId: h.id,
          sessionId: h.sessionId,
          source: h.source,
          role: h.role,
          contentType: h.contentType,
          createdAt: h.createdAt,
          sessionTitle: h.title,
          sessionCwd: h.cwd,
          snippet: h.snippet.replace(/\s+/g, ' ').trim(),
        })),
      });
    },
  );
}
