export interface OmcEvent {
  v: 1;
  type: 'session' | 'message' | 'artifact';
  data: Record<string, unknown>;
}

export type WebSource = 'chatgpt-web' | 'claude-web';

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function isoFromEpochSeconds(v: unknown): string | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return undefined;
  return new Date(v * 1000).toISOString();
}

function isoFromString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

function minIso(a: string | undefined, b: string): string {
  return a === undefined || b < a ? b : a;
}

function maxIso(a: string | undefined, b: string): string {
  return a === undefined || b > a ? b : a;
}

type Role = 'user' | 'assistant' | 'system' | 'tool';

interface PendingMessage {
  source: WebSource;
  convId: string;
  nativeId: string;
  role: Role;
  content: string;
  contentType: 'text' | 'tool_use' | 'tool_result';
  createdAt: string;
  model?: string;
  metadata?: Record<string, unknown>;
}

async function buildEvents(
  source: WebSource,
  convId: string,
  info: { title?: string; startedAt?: string; endedAt?: string; model?: string },
  pending: PendingMessage[],
): Promise<OmcEvent[]> {
  if (pending.length === 0) return [];
  const sid = await sha256Hex(`session:${source}:${convId}`);
  let firstTs = info.startedAt;
  let lastTs = info.endedAt;
  for (const m of pending) {
    firstTs = minIso(firstTs, m.createdAt);
    lastTs = maxIso(lastTs, m.createdAt);
  }
  const events: OmcEvent[] = [
    {
      v: 1,
      type: 'session',
      data: {
        id: sid,
        source,
        externalId: convId,
        ...(info.title ? { title: info.title } : {}),
        startedAt: firstTs,
        ...(lastTs ? { endedAt: lastTs } : {}),
        ...(info.model ? { model: info.model } : {}),
      },
    },
  ];
  for (const m of pending) {
    events.push({
      v: 1,
      type: 'message',
      data: {
        id: await sha256Hex(`message:${source}:${convId}:${m.nativeId}`),
        sessionId: sid,
        role: m.role,
        content: m.content,
        contentType: m.contentType,
        createdAt: m.createdAt,
        ...(m.model ? { model: m.model } : {}),
        ...(m.metadata && Object.keys(m.metadata).length > 0 ? { metadata: m.metadata } : {}),
      },
    });
  }
  return events;
}

/**
 * chatgpt.com GET /backend-api/conversation/<id> response → OMC events.
 * Shape reference: pionxzh/chatgpt-exporter src/api.ts (mapping tree of nodes
 * with message.author.role / content.content_type+parts / metadata.model_slug).
 */
export async function normalizeChatGptConversation(json: unknown): Promise<OmcEvent[]> {
  try {
    if (!json || typeof json !== 'object') return [];
    const root = json as Record<string, unknown>;
    const convId = str(root.conversation_id) ?? str(root.id);
    const mapping = root.mapping;
    if (!convId || !mapping || typeof mapping !== 'object') return [];
    const pending: PendingMessage[] = [];
    const seen = new Set<string>();
    let model: string | undefined;
    for (const node of Object.values(mapping)) {
      try {
        const msg = (node as Record<string, unknown> | null)?.message;
        if (!msg || typeof msg !== 'object') continue;
        const m = msg as Record<string, unknown>;
        const nativeId = str(m.id);
        if (!nativeId || seen.has(nativeId)) continue;
        const author = m.author as Record<string, unknown> | undefined;
        const roleRaw = str(author?.role);
        const role: Role | null =
          roleRaw === 'user' || roleRaw === 'assistant' || roleRaw === 'system' || roleRaw === 'tool'
            ? roleRaw
            : null;
        if (!role) continue;
        const createdAt = isoFromEpochSeconds(m.create_time);
        if (!createdAt) continue;
        const meta = m.metadata as Record<string, unknown> | undefined;
        if (meta?.is_visually_hidden_from_conversation === true) continue;
        const modelSlug = str(meta?.model_slug);
        if (modelSlug && role === 'assistant') model ??= modelSlug;
        const content = m.content as Record<string, unknown> | undefined;
        const ctype = str(content?.content_type) ?? 'text';
        let text = '';
        let contentType: PendingMessage['contentType'] = 'text';
        let skippedBlocks = 0;
        if ((ctype === 'text' || ctype === 'multimodal_text') && Array.isArray(content?.parts)) {
          const parts = content.parts as unknown[];
          text = parts.filter((p): p is string => typeof p === 'string').join('\n');
          skippedBlocks = parts.length - parts.filter((p) => typeof p === 'string').length;
        } else if (ctype === 'code') {
          contentType = 'tool_use';
          text = str(content?.text) ?? '';
        } else if (ctype === 'execution_output') {
          contentType = 'tool_result';
          text = str(content?.text) ?? '';
        } else {
          // thoughts / reasoning_recap / tether_* / user_editable_context …
          continue;
        }
        if (!text.trim()) continue;
        seen.add(nativeId);
        pending.push({
          source: 'chatgpt-web',
          convId,
          nativeId,
          role,
          content: text,
          contentType,
          createdAt,
          ...(modelSlug ? { model: modelSlug } : {}),
          metadata: {
            webContentType: ctype,
            ...(skippedBlocks > 0 ? { skippedBlocks } : {}),
          },
        });
      } catch {
        // one bad node must not lose the conversation
      }
    }
    pending.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    return buildEvents('chatgpt-web', convId, {
      ...(str(root.title) ? { title: str(root.title) } : {}),
      startedAt: isoFromEpochSeconds(root.create_time),
      endedAt: isoFromEpochSeconds(root.update_time),
      ...(model ? { model } : {}),
    }, pending);
  } catch {
    return [];
  }
}

/**
 * claude.ai GET /api/organizations/<org>/chat_conversations/<id> response →
 * OMC events. Shape: {uuid, name, created_at, updated_at, model,
 * chat_messages: [{uuid, sender, created_at, content: [{type, text}]}]}.
 */
export async function normalizeClaudeConversation(json: unknown): Promise<OmcEvent[]> {
  try {
    if (!json || typeof json !== 'object') return [];
    const root = json as Record<string, unknown>;
    const convId = str(root.uuid);
    const messages = root.chat_messages;
    if (!convId || !Array.isArray(messages)) return [];
    const pending: PendingMessage[] = [];
    const seen = new Set<string>();
    const convModel = str(root.model);
    for (const rawMsg of messages) {
      try {
        if (!rawMsg || typeof rawMsg !== 'object') continue;
        const m = rawMsg as Record<string, unknown>;
        const nativeId = str(m.uuid);
        if (!nativeId || seen.has(nativeId)) continue;
        const sender = str(m.sender);
        const role: Role | null = sender === 'human' ? 'user' : sender === 'assistant' ? 'assistant' : null;
        if (!role) continue;
        const createdAt = isoFromString(m.created_at);
        if (!createdAt) continue;
        let text = '';
        let skippedBlocks = 0;
        const content = m.content;
        if (Array.isArray(content)) {
          const texts: string[] = [];
          for (const block of content) {
            if (block && typeof block === 'object' && (block as Record<string, unknown>).type === 'text') {
              const t = str((block as Record<string, unknown>).text);
              if (t) texts.push(t);
            } else {
              skippedBlocks++;
            }
          }
          text = texts.join('\n');
        } else if (typeof content === 'string') {
          text = content;
        }
        const attachments = Array.isArray(m.attachments) ? m.attachments.length : 0;
        if (!text.trim() && attachments === 0) continue;
        seen.add(nativeId);
        pending.push({
          source: 'claude-web',
          convId,
          nativeId,
          role,
          content: text || `[${attachments} attachment(s)]`,
          contentType: 'text',
          createdAt,
          metadata: {
            ...(skippedBlocks > 0 ? { skippedBlocks } : {}),
            ...(attachments > 0 ? { attachments } : {}),
          },
        });
      } catch {
        // one bad message must not lose the conversation
      }
    }
    pending.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    return buildEvents('claude-web', convId, {
      ...(str(root.name) ? { title: str(root.name) } : {}),
      startedAt: isoFromString(root.created_at),
      endedAt: isoFromString(root.updated_at),
      ...(convModel ? { model: convModel } : {}),
    }, pending);
  } catch {
    return [];
  }
}
