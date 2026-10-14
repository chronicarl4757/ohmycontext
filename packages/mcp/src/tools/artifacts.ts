import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OmcStore } from '@ohmycontext/core';
import { jsonContent } from './common.js';

export function registerListArtifacts(server: McpServer, store: OmcStore): void {
  server.registerTool(
    'list_artifacts',
    {
      title: 'List artifacts',
      description: 'List artifacts (files written, URLs, images) produced or referenced by AI sessions.',
      inputSchema: {
        sessionId: z.string().optional().describe('full session id or a unique prefix'),
        kind: z.enum(['file', 'url', 'image', 'other']).optional(),
        pathPrefix: z.string().optional().describe('only artifacts whose path starts with this'),
        limit: z.number().int().min(1).max(200).default(50),
      },
    },
    async ({ sessionId, kind, pathPrefix, limit }) => {
      const resolved = sessionId ? store.resolveSessionId(sessionId) : null;
      if (sessionId && !resolved) {
        return {
          content: [{ type: 'text' as const, text: `session not found or prefix ambiguous: ${sessionId}` }],
          isError: true as const,
        };
      }
      const filter = {
        ...(resolved ? { sessionId: resolved } : {}),
        ...(kind ? { kind } : {}),
        ...(pathPrefix ? { pathPrefix } : {}),
      };
      const total = store.artifactCount(filter);
      const artifacts = store.getArtifacts({ ...filter, limit });
      return jsonContent({
        total,
        returned: artifacts.length,
        truncated: total > artifacts.length,
        artifacts: artifacts.map((a) => ({
          id: a.id,
          sessionId: a.sessionId ?? null,
          messageId: a.messageId ?? null,
          kind: a.kind,
          path: a.path ?? null,
          uri: a.uri ?? null,
          bytes: a.bytes ?? null,
          createdAt: a.createdAt,
        })),
      });
    },
  );
}
