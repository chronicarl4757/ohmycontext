import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { OMC_VERSION, type OmcStore } from '@ohmycontext/core';
import { registerSearchContext } from './tools/search.js';
import { registerGetSession, registerListSessions } from './tools/sessions.js';
import { registerRecentActivity } from './tools/activity.js';
import { registerListArtifacts } from './tools/artifacts.js';
import { registerContextStats } from './tools/stats.js';
import {
  registerBusChannels,
  registerBusPost,
  registerBusRead,
  registerBusWait,
} from './tools/bus.js';

export interface McpServerOptions {
  store: OmcStore;
}

export function createMcpServer(opts: McpServerOptions): McpServer {
  const server = new McpServer({ name: 'ohmycontext', version: OMC_VERSION });
  // aborted when the server closes so long-polling tools (bus_wait) resolve
  // promptly instead of hanging the shutdown
  const shutdown = new AbortController();
  const origClose = server.close.bind(server);
  server.close = async () => {
    shutdown.abort();
    await origClose();
  };
  registerSearchContext(server, opts.store);
  registerListSessions(server, opts.store);
  registerGetSession(server, opts.store);
  registerRecentActivity(server, opts.store);
  registerListArtifacts(server, opts.store);
  registerContextStats(server, opts.store);
  registerBusPost(server, opts.store);
  registerBusRead(server, opts.store);
  registerBusWait(server, opts.store, shutdown.signal);
  registerBusChannels(server, opts.store);
  return server;
}
