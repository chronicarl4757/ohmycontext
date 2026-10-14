import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  artifactId,
  contentMessageId,
  messageId,
  sessionId as makeSessionId,
  type OmcEvent,
} from '@ohmycontext/core';
import { readNewLines } from './tail.js';
import type { Connector, ParseResult } from './types.js';
import { iso, maxIso, minIso, num, str, toolUseText, trunc } from './util.js';

const SOURCE = 'claude-code';
const FILE_ARTIFACT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const MAX_CONTENT = 100_000;

interface SessionAcc {
  cwd?: string;
  title?: string;
  firstTs?: string;
  lastTs?: string;
  model?: string;
}

function accFor(sessions: Map<string, SessionAcc>, extId: string): SessionAcc {
  let acc = sessions.get(extId);
  if (!acc) {
    acc = {};
    sessions.set(extId, acc);
  }
  return acc;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    else if (typeof b.type === 'string') parts.push(`[${b.type}]`);
  }
  return parts.join('\n');
}

function collect(rec: unknown, sessions: Map<string, SessionAcc>, events: OmcEvent[]): void {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return;
  const line = rec as Record<string, unknown>;
  const type = str(line.type);
  if (type === 'summary' || type === 'ai-title') {
    const ext = str(line.sessionId);
    const title = str(line.summary) ?? str(line.aiTitle);
    if (ext && title) accFor(sessions, ext).title = title;
    return;
  }
  if (type !== 'user' && type !== 'assistant') return;
  const ext = str(line.sessionId);
  const ts = iso(line.timestamp);
  if (!ext || !ts) return;
  const acc = accFor(sessions, ext);
  acc.firstTs = minIso(acc.firstTs, ts);
  acc.lastTs = maxIso(acc.lastTs, ts);
  const cwd = str(line.cwd);
  if (cwd) acc.cwd = cwd;
  const msg = line.message;
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
  const m = msg as Record<string, unknown>;
  const role = type === 'user' ? ('user' as const) : ('assistant' as const);
  const model = str(m.model);
  if (model && !acc.model) acc.model = model;
  const sid = makeSessionId(SOURCE, ext);
  const uuid = str(line.uuid);
  const parentUuid = str(line.parentUuid);
  const gitBranch = str(line.gitBranch);
  const baseMeta: Record<string, unknown> = {
    ...(uuid ? { sourceUuid: uuid } : {}),
    ...(parentUuid ? { sourceParentUuid: parentUuid } : {}),
    ...(gitBranch ? { gitBranch } : {}),
  };
  const usageRaw = m.usage;
  const tokenUsage =
    usageRaw && typeof usageRaw === 'object' && !Array.isArray(usageRaw)
      ? (() => {
          const u = usageRaw as Record<string, unknown>;
          const input = num(u.input_tokens);
          const output = num(u.output_tokens);
          return input !== undefined || output !== undefined
            ? { ...(input !== undefined ? { input } : {}), ...(output !== undefined ? { output } : {}) }
            : undefined;
        })()
      : undefined;

  const startIdx = events.length;
  const content = m.content;
  if (typeof content === 'string') {
    if (content.trim()) {
      events.push({
        v: 1,
        type: 'message',
        data: {
          id: uuid
            ? messageId(SOURCE, ext, uuid)
            : contentMessageId({ source: SOURCE, sessionExternalId: ext, role, createdAt: ts, content }),
          sessionId: sid,
          role,
          content: trunc(content, MAX_CONTENT),
          contentType: 'text',
          createdAt: ts,
          ...(model ? { model } : {}),
          ...(Object.keys(baseMeta).length > 0 ? { metadata: baseMeta } : {}),
        },
      });
    }
  } else if (Array.isArray(content)) {
    for (let i = 0; i < content.length; i++) {
      const block = content[i];
      if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
      const b = block as Record<string, unknown>;
      const btype = str(b.type);
      // a tool_result reuses its tool_use block id (tool_use_id), so it needs a
      // distinct suffix to not collide with the call message
      const native =
        str(b.id) ??
        (str(b.tool_use_id) ? `${str(b.tool_use_id)}#result` : undefined) ??
        (uuid ? `${uuid}#${i}` : undefined);
      const id = native
        ? messageId(SOURCE, ext, native)
        : contentMessageId({
            source: SOURCE,
            sessionExternalId: ext,
            role,
            createdAt: ts,
            content: JSON.stringify(b).slice(0, 1000),
            seq: i,
          });
      if (btype === 'text') {
        const text = str(b.text);
        if (!text || !text.trim()) continue;
        events.push({
          v: 1,
          type: 'message',
          data: {
            id,
            sessionId: sid,
            role,
            content: trunc(text, MAX_CONTENT),
            contentType: 'text',
            createdAt: ts,
            ...(model ? { model } : {}),
            ...(Object.keys(baseMeta).length > 0 ? { metadata: baseMeta } : {}),
          },
        });
      } else if (btype === 'tool_use') {
        const name = str(b.name) ?? 'tool';
        events.push({
          v: 1,
          type: 'message',
          data: {
            id,
            sessionId: sid,
            role: 'assistant',
            content: toolUseText(name, b.input),
            contentType: 'tool_use',
            createdAt: ts,
            ...(model ? { model } : {}),
            metadata: { ...baseMeta, tool: name },
          },
        });
        const input =
          b.input && typeof b.input === 'object' && !Array.isArray(b.input)
            ? (b.input as Record<string, unknown>)
            : undefined;
        const filePath = str(input?.file_path) ?? str(input?.notebook_path);
        if (FILE_ARTIFACT_TOOLS.has(name) && filePath) {
          events.push({
            v: 1,
            type: 'artifact',
            data: {
              id: artifactId({
                source: SOURCE,
                sessionExternalId: ext,
                nativeMessageId: native,
                kind: 'file',
                ref: filePath,
              }),
              sessionId: sid,
              messageId: id,
              kind: 'file',
              path: filePath,
              createdAt: ts,
            },
          });
        }
      } else if (btype === 'tool_result') {
        const text = toolResultText(b.content);
        if (!text.trim()) continue;
        const toolUseId = str(b.tool_use_id);
        events.push({
          v: 1,
          type: 'message',
          data: {
            id,
            sessionId: sid,
            role: 'tool',
            content: trunc(text, MAX_CONTENT),
            contentType: 'tool_result',
            createdAt: ts,
            ...(toolUseId ? { parentId: messageId(SOURCE, ext, toolUseId) } : {}),
            metadata: { ...baseMeta, ...(toolUseId ? { toolUseId } : {}) },
          },
        });
      }
      // thinking / redacted_thinking / image and unknown blocks are dropped by design
    }
  }
  if (tokenUsage && events.length > startIdx) {
    const first = events[startIdx];
    if (first && first.type === 'message') first.data.tokenUsage = tokenUsage;
  }
}

export function claudeCodeConnector(): Connector {
  return {
    name: SOURCE,
    dirs: () => [join(homedir(), '.claude', 'projects')],
    async parse(filePath: string, offset: number): Promise<ParseResult> {
      const { lines, offset: next } = await readNewLines(filePath, offset);
      const events: OmcEvent[] = [];
      const sessions = new Map<string, SessionAcc>();
      for (const line of lines) {
        let rec: unknown;
        try {
          rec = JSON.parse(line);
        } catch {
          continue; // malformed line: never let one bad line kill a scan
        }
        collect(rec, sessions, events);
      }
      for (const [extId, acc] of sessions) {
        if (!acc.firstTs) continue;
        events.push({
          v: 1,
          type: 'session',
          data: {
            id: makeSessionId(SOURCE, extId),
            source: SOURCE,
            externalId: extId,
            ...(acc.title ? { title: acc.title } : {}),
            ...(acc.cwd ? { cwd: acc.cwd } : {}),
            startedAt: acc.firstTs,
            ...(acc.lastTs ? { endedAt: acc.lastTs } : {}),
            ...(acc.model ? { model: acc.model } : {}),
          },
        });
      }
      return { events, offset: next };
    },
  };
}
