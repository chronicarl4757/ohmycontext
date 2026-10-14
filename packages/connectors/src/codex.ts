import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import {
  artifactId,
  contentMessageId,
  messageId,
  sessionId as makeSessionId,
  type OmcEvent,
} from '@ohmycontext/core';
import { readNewLines } from './tail.js';
import type { Connector, ParseResult } from './types.js';
import { iso, maxIso, minIso, str, toolUseText, trunc, tryParseJson } from './util.js';

const SOURCE = 'codex';
const MAX_CONTENT = 100_000;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const PATCH_FILE_RE = /\*\*\* (?:Update|Add|Delete) File: (.+)/g;
const FILE_TOOL_RE = /write|edit|patch/i;
const ROLES = new Set(['user', 'assistant', 'system', 'tool']);

interface SessionAcc {
  extId: string;
  firstTs: string;
  lastTs?: string;
  cwd?: string;
  metadata?: Record<string, unknown>;
}

function uuidFromFilename(filePath: string): string | undefined {
  return UUID_RE.exec(basename(filePath))?.[0];
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const text = str((item as Record<string, unknown>).text);
    if (text) parts.push(text);
  }
  return parts.join('\n');
}

function fileRefsFromCall(name: string, args: unknown): string[] {
  if (!FILE_TOOL_RE.test(name)) return [];
  const refs: string[] = [];
  if (typeof args === 'string') {
    for (const m of args.matchAll(PATCH_FILE_RE)) {
      if (m[1]) refs.push(m[1].trim());
      if (refs.length >= 20) break;
    }
    return refs;
  }
  const parsed = tryParseJson(args);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const rec = parsed as Record<string, unknown>;
    const p = str(rec.file_path) ?? str(rec.path);
    if (p) refs.push(p);
  }
  return refs;
}

export function codexConnector(): Connector {
  return {
    name: SOURCE,
    dirs: () => [join(homedir(), '.codex', 'sessions')],
    async parse(filePath: string, offset: number): Promise<ParseResult> {
      const { lines, offset: next } = await readNewLines(filePath, offset);
      const events: OmcEvent[] = [];
      const fileExt = uuidFromFilename(filePath);
      let acc: SessionAcc | null = null;
      const ensureAcc = (ts: string): SessionAcc => {
        acc ??= { extId: fileExt ?? 'unknown', firstTs: ts };
        acc.firstTs = minIso(acc.firstTs, ts);
        acc.lastTs = maxIso(acc.lastTs, ts);
        return acc;
      };
      for (const line of lines) {
        let rec: unknown;
        try {
          rec = JSON.parse(line);
        } catch {
          continue; // malformed line: never let one bad line kill a scan
        }
        if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
        const l = rec as Record<string, unknown>;
        const ts = iso(l.timestamp);
        if (!ts) continue;
        const type = str(l.type);
        if (type === 'session_meta') {
          const p = (l.payload ?? {}) as Record<string, unknown>;
          const a = ensureAcc(iso(p.timestamp) ?? ts);
          const ext = str(p.id) ?? str(p.session_id);
          if (ext) a.extId = ext;
          const cwd = str(p.cwd);
          if (cwd) a.cwd = cwd;
          const meta: Record<string, unknown> = {};
          for (const k of ['cli_version', 'model_provider', 'originator', 'source']) {
            const v = p[k];
            if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') meta[k] = v;
          }
          const git = p.git;
          if (git && typeof git === 'object' && !Array.isArray(git)) {
            const branch = str((git as Record<string, unknown>).branch);
            if (branch) meta.git_branch = branch;
          }
          if (Object.keys(meta).length > 0) a.metadata = { ...(a.metadata ?? {}), ...meta };
          continue;
        }
        if (type !== 'response_item') continue;
        const p = l.payload;
        if (!p || typeof p !== 'object' || Array.isArray(p)) continue;
        const a = ensureAcc(ts);
        const ext = a.extId;
        const sid = makeSessionId(SOURCE, ext);
        const ordinal = typeof l.ordinal === 'number' ? l.ordinal : '';
        const pl = p as Record<string, unknown>;
        const ptype = str(pl.type);
        if (ptype === 'message') {
          const roleRaw = str(pl.role) ?? 'user';
          const role = roleRaw === 'developer' ? 'system' : ROLES.has(roleRaw) ? roleRaw : 'system';
          const text = contentText(pl.content);
          if (!text.trim()) continue;
          events.push({
            v: 1,
            type: 'message',
            data: {
              id: contentMessageId({
                source: SOURCE,
                sessionExternalId: ext,
                role,
                createdAt: ts,
                content: text,
                seq: ordinal,
              }),
              sessionId: sid,
              role: role as 'user' | 'assistant' | 'system' | 'tool',
              content: trunc(text, MAX_CONTENT),
              contentType: 'text',
              createdAt: ts,
            },
          });
        } else if (ptype && ptype.endsWith('_call')) {
          const name = str(pl.name) ?? 'tool';
          const callId = str(pl.call_id) ?? str(pl.id);
          const args = pl.arguments ?? pl.input;
          const id = callId
            ? messageId(SOURCE, ext, callId)
            : contentMessageId({
                source: SOURCE,
                sessionExternalId: ext,
                role: 'assistant',
                createdAt: ts,
                content: `${name}:${typeof args === 'string' ? args.slice(0, 1000) : JSON.stringify(args ?? '').slice(0, 1000)}`,
                seq: ordinal,
              });
          events.push({
            v: 1,
            type: 'message',
            data: {
              id,
              sessionId: sid,
              role: 'assistant',
              content: toolUseText(name, args),
              contentType: 'tool_use',
              createdAt: ts,
              metadata: { tool: name },
            },
          });
          for (const ref of fileRefsFromCall(name, args)) {
            events.push({
              v: 1,
              type: 'artifact',
              data: {
                id: artifactId({
                  source: SOURCE,
                  sessionExternalId: ext,
                  nativeMessageId: callId,
                  kind: 'file',
                  ref,
                }),
                sessionId: sid,
                messageId: id,
                kind: 'file',
                path: ref,
                createdAt: ts,
              },
            });
          }
        } else if (ptype && ptype.endsWith('_call_output')) {
          const callId = str(pl.call_id) ?? str(pl.id);
          const out = typeof pl.output === 'string' ? pl.output : JSON.stringify(pl.output ?? '');
          if (!out || !out.trim()) continue;
          events.push({
            v: 1,
            type: 'message',
            data: {
              id: callId
                ? messageId(SOURCE, ext, `${callId}#output`)
                : contentMessageId({
                    source: SOURCE,
                    sessionExternalId: ext,
                    role: 'tool',
                    createdAt: ts,
                    content: out.slice(0, 1000),
                    seq: ordinal,
                  }),
              sessionId: sid,
              role: 'tool',
              content: trunc(out, MAX_CONTENT),
              contentType: 'tool_result',
              createdAt: ts,
              ...(callId ? { parentId: messageId(SOURCE, ext, callId) } : {}),
              ...(callId ? { metadata: { toolUseId: callId } } : {}),
            },
          });
        }
        // reasoning / event_msg / turn_context and unknown payload types are skipped
      }
      if (acc !== null) {
        const a: SessionAcc = acc;
        events.push({
          v: 1,
          type: 'session',
          data: {
            id: makeSessionId(SOURCE, a.extId),
            source: SOURCE,
            externalId: a.extId,
            startedAt: a.firstTs,
            ...(a.lastTs ? { endedAt: a.lastTs } : {}),
            ...(a.cwd ? { cwd: a.cwd } : {}),
            ...(a.metadata ? { metadata: a.metadata } : {}),
          },
        });
      }
      return { events, offset: next };
    },
  };
}
