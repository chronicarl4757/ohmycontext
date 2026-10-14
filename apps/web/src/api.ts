export interface SourceStat {
  source: string;
  sessions: number;
  messages: number;
  artifacts: number;
}

export interface Overview {
  version: string;
  dbBytes: number;
  totals: { sessions: number; messages: number; artifacts: number; events: number };
  sources: SourceStat[];
  earliest: string | null;
  latest: string | null;
}

export interface RecentSession {
  id: string;
  source: string;
  title?: string;
  cwd?: string;
  startedAt: string;
  endedAt?: string;
  messageCount: number;
  lastActivity: string;
  lastMessageRole: string | null;
  lastMessagePreview: string | null;
}

export interface SessionRow {
  id: string;
  source: string;
  title?: string;
  cwd?: string;
  startedAt: string;
  endedAt?: string;
  model?: string;
  messageCount: number;
}

export interface MessageRow {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  contentType: 'text' | 'tool_use' | 'tool_result';
  content: string;
  createdAt: string;
  model?: string;
}

export interface ArtifactRow {
  id: string;
  sessionId?: string;
  kind: 'file' | 'url' | 'image' | 'other';
  path?: string;
  uri?: string;
  bytes?: number;
  createdAt: string;
}

export interface SearchHit {
  messageId: string;
  sessionId: string;
  source: string | null;
  role: string;
  createdAt: string;
  snippet: string;
  sessionTitle: string | null;
  sessionCwd: string | null;
}

export interface BusMessage {
  seq: number;
  id: string;
  channel: string;
  sender: string;
  content: string;
  refs?: string[];
  createdAt: string;
}

export interface BusChannel {
  channel: string;
  count: number;
  lastActivity: string;
  senders: string[];
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

function qs(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

export const api = {
  overview: () => getJson<Overview>('/api/overview'),
  activity: (minutes: number, limit = 20) =>
    getJson<{ sessions: RecentSession[]; total: number }>(`/api/activity${qs({ minutes, limit })}`),
  sessions: (source: string, limit: number, offset: number) =>
    getJson<{ sessions: SessionRow[]; total: number }>(`/api/sessions${qs({ source, limit, offset })}`),
  session: (id: string, limit: number, offset: number) =>
    getJson<{ session: SessionRow | null; messages: MessageRow[]; total: number; artifacts: ArtifactRow[] }>(
      `/api/sessions/${id}${qs({ limit, offset })}`,
    ),
  search: (q: string, source: string, limit: number, offset: number) =>
    getJson<{ hits: SearchHit[]; total: number }>(`/api/search${qs({ q, source, limit, offset })}`),
  artifacts: (kind: string, pathPrefix: string, limit: number, offset: number) =>
    getJson<{ artifacts: ArtifactRow[]; total: number }>(`/api/artifacts${qs({ kind, pathPrefix, limit, offset })}`),
  busChannels: () => getJson<{ channels: BusChannel[] }>('/bus/channels'),
  busRead: (channel: string, afterSeq: number, limit = 500) =>
    getJson<{ messages: BusMessage[]; latestSeq: number; truncated: boolean }>(
      `/bus/read${qs({ channel, after_seq: afterSeq, limit })}`,
    ),
  async busPost(input: { channel: string; sender: string; content: string; clientMsgId: string }): Promise<void> {
    const res = await fetch('/bus/post', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  },
};
