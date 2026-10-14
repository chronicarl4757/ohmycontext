import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OmcStore } from '@ohmycontext/core';
import { jsonContent } from './common.js';

export function registerContextStats(server: McpServer, store: OmcStore): void {
  server.registerTool(
    'context_stats',
    {
      title: 'Context stats',
      description: 'Overview of the captured context store: counts per source, time range, database size.',
      inputSchema: {},
    },
    async () => {
      const st = store.stats();
      return jsonContent({
        version: st.version,
        totals: st.totals,
        sources: st.sources,
        earliest: st.earliest,
        latest: st.latest,
        dbBytes: st.dbBytes,
        dbMiB: Math.round((st.dbBytes / 1024 / 1024) * 10) / 10,
      });
    },
  );
}
