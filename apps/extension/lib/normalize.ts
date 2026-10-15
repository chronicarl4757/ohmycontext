export interface OmcEvent {
  v: 1;
  type: 'session' | 'message' | 'artifact';
  data: Record<string, unknown>;
}

export type WebSource = 'chatgpt-web' | 'claude-web' | 'deepseek-web' | 'kimi-web';

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
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

/** accepts epoch seconds or ISO strings */
function anyIso(v: unknown): string | undefined {
  return isoFromEpochSeconds(v) ?? isoFromString(v);
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
  /** source-native parent id; resolved to an OMC message id in buildEvents */
  parentNative?: string;
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
        ...(m.parentNative
          ? { parentId: await sha256Hex(`message:${source}:${convId}:${m.parentNative}`) }
          : {}),
        ...(m.metadata && Object.keys(m.metadata).length > 0 ? { metadata: m.metadata } : {}),
      },
    });
  }
  return events;
}

// ---------- chatgpt.com ----------

const CHATGPT_SKIP_CONTENT_TYPES = new Set([
  'thoughts',
  'reasoning_recap',
  'tether_quote',
  'tether_browsing_code',
  'tether_browsing_display',
  'user_editable_context',
  'model_editable_context',
]);

function chatGptMessage(source: WebSource, convId: string, m: Record<string, unknown>): PendingMessage | null {
  const nativeId = str(m.id);
  if (!nativeId) return null;
  const author = m.author as Record<string, unknown> | undefined;
  const roleRaw = str(author?.role) ?? str(m.role);
  const role: Role | null =
    roleRaw === 'user' || roleRaw === 'assistant' || roleRaw === 'system' || roleRaw === 'tool' ? roleRaw : null;
  if (!role) return null;
  const createdAt = anyIso(m.create_time) ?? anyIso(m.created_at);
  if (!createdAt) return null;
  const meta = m.metadata as Record<string, unknown> | undefined;
  if (meta?.is_visually_hidden_from_conversation === true || meta?.is_thinking_preamble_message === true) {
    return null;
  }
  const modelSlug = str(meta?.model_slug);
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
  } else if (CHATGPT_SKIP_CONTENT_TYPES.has(ctype)) {
    return null;
  } else {
    return null;
  }
  if (!text.trim()) return null;
  return {
    source,
    convId,
    nativeId,
    role,
    content: text,
    contentType,
    createdAt,
    ...(modelSlug ? { model: modelSlug } : {}),
    metadata: { webContentType: ctype, ...(skippedBlocks > 0 ? { skippedBlocks } : {}) },
  };
}

/**
 * chatgpt.com conversation → OMC events. Two wire variants exist:
 * legacy `{mapping: {<nodeId>: {message}}}` (walk all nodes) and the 2026 flat
 * `{messages: [...]}`. Timestamps may be epoch seconds or ISO strings.
 * Shape reference: pionxzh/chatgpt-exporter src/api.ts.
 */
export async function normalizeChatGptConversation(json: unknown): Promise<OmcEvent[]> {
  try {
    if (!json || typeof json !== 'object') return [];
    const root = json as Record<string, unknown>;
    const convId = str(root.conversation_id) ?? str(root.id);
    if (!convId) return [];
    const pending: PendingMessage[] = [];
    const seen = new Set<string>();
    let model: string | undefined;
    const rawMessages: Record<string, unknown>[] = [];
    const mapping = root.mapping;
    if (mapping && typeof mapping === 'object') {
      for (const node of Object.values(mapping)) {
        try {
          const msg = (node as Record<string, unknown> | null)?.message;
          if (msg && typeof msg === 'object') rawMessages.push(msg as Record<string, unknown>);
        } catch {
          // skip bad node
        }
      }
    } else if (Array.isArray(root.messages)) {
      for (const m of root.messages) {
        if (m && typeof m === 'object') rawMessages.push(m as Record<string, unknown>);
      }
    }
    if (rawMessages.length === 0) return [];
    for (const m of rawMessages) {
      try {
        const p = chatGptMessage('chatgpt-web', convId, m);
        if (!p || seen.has(p.nativeId)) continue;
        seen.add(p.nativeId);
        if (p.model && p.role === 'assistant') model ??= p.model;
        pending.push(p);
      } catch {
        // one bad message must not lose the conversation
      }
    }
    pending.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    return buildEvents('chatgpt-web', convId, {
      ...(str(root.title) ? { title: str(root.title) } : {}),
      startedAt: anyIso(root.create_time),
      endedAt: anyIso(root.update_time),
      ...(model ? { model } : {}),
    }, pending);
  } catch {
    return [];
  }
}

// ---------- claude.ai ----------

/**
 * claude.ai GET /api/organizations/<org>/chat_conversations/<id> response →
 * OMC events: {uuid, name, created_at, updated_at, model, chat_messages:[...]}.
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

// ---------- chat.deepseek.com ----------

/**
 * DeepSeek history payload → OMC events. Accepts the raw
 * GET /api/v0/chat/history_messages response or `{messages: <response>,
 * title?, chatId?}` as wrapped by the page hook. The visible branch is
 * reconstructed by walking parent_id from chat_session.current_message_id.
 */
export async function normalizeDeepSeek(payload: unknown): Promise<OmcEvent[]> {
  try {
    if (!payload || typeof payload !== 'object') return [];
    const p = payload as Record<string, unknown>;
    const resp = (p.messages && typeof p.messages === 'object' ? p.messages : p) as Record<string, unknown>;
    const data = resp.data as Record<string, unknown> | undefined;
    const biz = data?.biz_data as Record<string, unknown> | undefined;
    if (!biz) return [];
    const chatSession = biz.chat_session as Record<string, unknown> | undefined;
    const rawMsgs = biz.chat_messages;
    if (!Array.isArray(rawMsgs)) return [];
    const convId = str(chatSession?.id) ?? str(p.chatId);
    if (!convId) return [];

    const byId = new Map<string, Record<string, unknown>>();
    for (const m of rawMsgs) {
      if (m && typeof m === 'object') {
        const id = str((m as Record<string, unknown>).message_id);
        if (id) byId.set(id, m as Record<string, unknown>);
      }
    }
    const chain: Record<string, unknown>[] = [];
    let cur = str(chatSession?.current_message_id);
    for (let guard = 0; cur && byId.has(cur) && guard < 10_000; guard++) {
      const m = byId.get(cur)!;
      chain.unshift(m);
      cur = str(m.parent_id);
    }
    const ordered = chain.length > 0 ? chain : (rawMsgs as Record<string, unknown>[]);

    const pending: PendingMessage[] = [];
    for (const m of ordered) {
      try {
        const nativeId = str(m.message_id);
        if (!nativeId) continue;
        const roleRaw = str(m.role);
        const role: Role | null = roleRaw === 'USER' ? 'user' : roleRaw === 'ASSISTANT' ? 'assistant' : null;
        if (!role) continue;
        const createdAt = anyIso(m.inserted_at);
        if (!createdAt) continue;
        const fragments = Array.isArray(m.fragments) ? (m.fragments as Record<string, unknown>[]) : [];
        const texts: string[] = [];
        let thinkSecs: number | undefined;
        for (const f of fragments) {
          const ft = str(f?.type);
          if (ft === 'REQUEST' || ft === 'RESPONSE') {
            const t = str(f.content);
            if (t) texts.push(t);
          } else if (ft === 'THINK') {
            thinkSecs ??= num(f.elapsed_secs);
          }
        }
        const text = texts.join('\n');
        if (!text.trim()) continue;
        pending.push({
          source: 'deepseek-web',
          convId,
          nativeId,
          role,
          content: text,
          contentType: 'text',
          createdAt,
          ...(thinkSecs !== undefined ? { metadata: { thinkingSecs: thinkSecs } } : {}),
        });
      } catch {
        // skip bad message
      }
    }
    return buildEvents('deepseek-web', convId, {
      ...(str(p.title) ? { title: str(p.title) } : {}),
      ...(str(chatSession?.title) ? { title: str(chatSession?.title) } : {}),
    }, pending);
  } catch {
    return [];
  }
}

// ---------- kimi.com / kimi.moonshot.cn ----------

/**
 * Kimi 2026 Connect-RPC wire format (verified live 2026-10): POST
 * /apiv2/kimi.gateway.chat.v1.ChatService/ListMessages →
 * {messages: [{id, parentId, role, status, blocks: [{text: {content}}]}]},
 * GetChat → {chat: {id, name}}. Message timestamps are not present on the wire;
 * when absent we stamp capture time and mark metadata.timeApproximate.
 */
export async function normalizeKimiApiv2(
  getChat: unknown,
  listMessagesBody: unknown,
  chatId: string,
): Promise<OmcEvent[]> {
  try {
    if (!chatId || !listMessagesBody || typeof listMessagesBody !== 'object') return [];
    const body = listMessagesBody as Record<string, unknown>;
    const msgs = body.messages;
    if (!Array.isArray(msgs)) return [];
    const gc = getChat && typeof getChat === 'object' ? (getChat as Record<string, unknown>) : undefined;
    const chat = gc?.chat && typeof gc.chat === 'object' ? (gc.chat as Record<string, unknown>) : undefined;
    const title = str(chat?.name) ?? str(gc?.name);
    const capturedAt = new Date().toISOString();

    const pending: PendingMessage[] = [];
    let skippedStatus = 0;
    let anyRealTs = false;
    for (const raw of msgs) {
      try {
        if (!raw || typeof raw !== 'object') continue;
        const m = raw as Record<string, unknown>;
        const nativeId = str(m.id);
        if (!nativeId) continue;
        const roleRaw = str(m.role);
        const role: Role | null = roleRaw === 'user' ? 'user' : roleRaw === 'assistant' ? 'assistant' : null;
        if (!role) continue;
        const status = str(m.status);
        if (status && status !== 'MESSAGE_STATUS_COMPLETED') {
          skippedStatus++;
          continue;
        }
        const blocks = Array.isArray(m.blocks) ? (m.blocks as Record<string, unknown>[]) : [];
        const texts: string[] = [];
        let skippedBlocks = 0;
        for (const b of blocks) {
          const t = b && typeof b === 'object' ? str((b.text as Record<string, unknown> | undefined)?.content) : undefined;
          if (t) texts.push(t);
          else skippedBlocks++;
        }
        const content = texts.join('\n');
        if (!content.trim()) continue;
        const realTs = anyIso(m.createdAt) ?? anyIso(m.created_at) ?? anyIso(m.createTime);
        if (realTs) anyRealTs = true;
        pending.push({
          source: 'kimi-web',
          convId: chatId,
          nativeId,
          role,
          content,
          contentType: 'text',
          createdAt: realTs ?? capturedAt,
          ...(str(m.parentId) ? { parentNative: str(m.parentId) } : {}),
          metadata: {
            ...(realTs ? {} : { timeApproximate: true }),
            ...(skippedBlocks > 0 ? { skippedBlocks } : {}),
          },
        });
      } catch {
        // skip bad message
      }
    }
    // wire order is chronological; only re-sort when real timestamps exist
    if (anyRealTs) pending.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    const events = await buildEvents(
      'kimi-web',
      chatId,
      { ...(title ? { title } : {}) },
      pending,
    );
    if (skippedStatus > 0 && events[0]) {
      events[0].data.metadata = { wire: 'apiv2', skippedMessages: skippedStatus };
    }
    return events;
  } catch {
    return [];
  }
}

/**
 * Legacy (pre-2026) Kimi scroll payload → OMC events, kept as fallback for the
 * old `{items: [...]}` shape. New captures go through normalizeKimiApiv2.
 */
export async function normalizeKimi(payload: unknown): Promise<OmcEvent[]> {
  try {
    if (!payload || typeof payload !== 'object') return [];
    const p = payload as Record<string, unknown>;
    const resp = (p.items && typeof p.items === 'object' && !Array.isArray(p.items) ? p.items : p) as Record<
      string,
      unknown
    >;
    const items = Array.isArray(resp.items) ? (resp.items as Record<string, unknown>[]) : null;
    if (!items) return [];
    const convId = str(p.chatId) ?? str(resp.id);
    if (!convId) return [];
    const pending: PendingMessage[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      try {
        if (!item || typeof item !== 'object') continue;
        const nativeId = str(item.id);
        if (!nativeId || seen.has(nativeId)) continue;
        const roleRaw = str(item.role);
        const role: Role | null = roleRaw === 'user' ? 'user' : roleRaw === 'assistant' ? 'assistant' : null;
        if (!role) continue;
        const createdAt = anyIso(item.created_at);
        if (!createdAt) continue;
        let text = str(item.content) ?? '';
        let skippedZones = 0;
        if (!text.trim()) {
          const zones = (item.contents as Record<string, unknown> | undefined)?.zones;
          if (Array.isArray(zones)) {
            const texts: string[] = [];
            for (const z of zones) {
              const sections = (z as Record<string, unknown>)?.sections;
              if (!Array.isArray(sections)) continue;
              for (const sec of sections) {
                const view = str((sec as Record<string, unknown>)?.view);
                if (view === 'cmpl') {
                  const t = str((sec as Record<string, unknown>).text) ?? str((sec as Record<string, unknown>).content);
                  if (t) texts.push(t.replace(/\[citation:\d+\]/g, ''));
                } else {
                  skippedZones++;
                }
              }
            }
            text = texts.join('\n');
          }
        }
        if (!text.trim()) continue;
        seen.add(nativeId);
        pending.push({
          source: 'kimi-web',
          convId,
          nativeId,
          role,
          content: text,
          contentType: 'text',
          createdAt,
          ...(skippedZones > 0 ? { metadata: { skippedZones } } : {}),
        });
      } catch {
        // skip bad item
      }
    }
    pending.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    return buildEvents('kimi-web', convId, { ...(str(p.title) ? { title: str(p.title) } : {}) }, pending);
  } catch {
    return [];
  }
}
