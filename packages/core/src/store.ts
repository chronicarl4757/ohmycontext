import Database from 'better-sqlite3';
import { mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  EventEnvelopeSchema,
  OmcEventSchema,
  type Artifact,
  type ArtifactKind,
  type Message,
  type OmcEvent,
  type Role,
  type Session,
} from './schema.js';
import { messageId, sessionId, sha256Hex } from './ids.js';

export const OMC_VERSION = '0.1.0';
export const BUS_SOURCE = 'omc-bus';

export interface BusMessage {
  seq: number;
  id: string;
  channel: string;
  sender: string;
  content: string;
  refs?: string[];
  createdAt: string;
}

export interface BusChannelInfo {
  channel: string;
  count: number;
  lastActivity: string;
  senders: string[];
}

export function omcHome(): string {
  const env = process.env.OMC_HOME;
  return env && env.length > 0 ? env : join(homedir(), '.ohmycontext');
}

export interface StoreOptions {
  home?: string;
  dbPath?: string;
}

export interface IngestError {
  index: number;
  error: string;
}

export interface IngestResult {
  ingested: number;
  skipped: number;
  unknown: number;
  errors: IngestError[];
}

export interface SearchOptions {
  source?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export interface SearchHit {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  contentType: string;
  createdAt: string;
  source: string | null;
  cwd: string | null;
  title: string | null;
  snippet: string;
}

export interface SessionListOptions {
  source?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export interface SessionSummary extends Session {
  messageCount: number;
  firstUserPreview: string | null;
}

export interface RecentSession extends SessionSummary {
  lastActivity: string;
  lastMessageRole: string | null;
  lastMessagePreview: string | null;
}

export interface MessageFilter {
  sessionId?: string;
  roles?: Role[];
  limit?: number;
  offset?: number;
}

export interface ArtifactFilter {
  sessionId?: string;
  kind?: ArtifactKind;
  pathPrefix?: string;
  limit?: number;
  offset?: number;
}

export interface SourceStat {
  source: string;
  sessions: number;
  messages: number;
  artifacts: number;
}

export interface StoreStats {
  version: string;
  dbPath: string;
  dbBytes: number;
  totals: { sessions: number; messages: number; artifacts: number; events: number };
  sources: SourceStat[];
  earliest: string | null;
  latest: string | null;
}

export interface SyncState {
  source: string;
  filePath: string;
  byteOffset: number;
  mtime: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT,
  cwd TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  model TEXT,
  metadata TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_title ON sessions(title);
CREATE INDEX IF NOT EXISTS idx_sessions_source ON sessions(source);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_source_external ON sessions(source, external_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'text',
  created_at TEXT NOT NULL,
  model TEXT,
  token_input INTEGER,
  token_output INTEGER,
  parent_id TEXT,
  metadata TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_session_role_created ON messages(session_id, role, created_at);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  message_id TEXT,
  kind TEXT NOT NULL,
  path TEXT,
  uri TEXT,
  hash TEXT,
  bytes INTEGER,
  created_at TEXT NOT NULL,
  metadata TEXT
);
CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id);

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL,
  type TEXT NOT NULL,
  session_id TEXT,
  raw TEXT NOT NULL,
  ingested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);

CREATE TABLE IF NOT EXISTS sync_state (
  source TEXT NOT NULL,
  file_path TEXT NOT NULL,
  byte_offset INTEGER NOT NULL DEFAULT 0,
  mtime INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source, file_path)
);

CREATE TABLE IF NOT EXISTS bus_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE,
  channel TEXT NOT NULL,
  sender TEXT NOT NULL,
  content TEXT NOT NULL,
  refs TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bus_channel ON bus_messages(channel, seq);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content, content='messages', content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
`;

function canonDate(s: string): string {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
}

function toFtsQuery(query: string): string {
  return query
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' ');
}

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

interface SessionRow {
  id: string;
  source: string;
  external_id: string;
  title: string | null;
  cwd: string | null;
  started_at: string;
  ended_at: string | null;
  model: string | null;
  metadata: string | null;
}

function rowToSession(r: SessionRow): Session {
  return {
    id: r.id,
    source: r.source,
    externalId: r.external_id,
    ...(r.title !== null ? { title: r.title } : {}),
    ...(r.cwd !== null ? { cwd: r.cwd } : {}),
    startedAt: r.started_at,
    ...(r.ended_at !== null ? { endedAt: r.ended_at } : {}),
    ...(r.model !== null ? { model: r.model } : {}),
    ...(r.metadata !== null ? { metadata: JSON.parse(r.metadata) as Record<string, unknown> } : {}),
  };
}

interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  content_type: string;
  created_at: string;
  model: string | null;
  token_input: number | null;
  token_output: number | null;
  parent_id: string | null;
  metadata: string | null;
}

function rowToMessage(r: MessageRow): Message {
  const tokenUsage =
    r.token_input !== null || r.token_output !== null
      ? {
          ...(r.token_input !== null ? { input: r.token_input } : {}),
          ...(r.token_output !== null ? { output: r.token_output } : {}),
        }
      : undefined;
  return {
    id: r.id,
    sessionId: r.session_id,
    role: r.role as Message['role'],
    content: r.content,
    contentType: r.content_type as Message['contentType'],
    createdAt: r.created_at,
    ...(r.model !== null ? { model: r.model } : {}),
    ...(tokenUsage ? { tokenUsage } : {}),
    ...(r.parent_id !== null ? { parentId: r.parent_id } : {}),
    ...(r.metadata !== null ? { metadata: JSON.parse(r.metadata) as Record<string, unknown> } : {}),
  };
}

interface ArtifactRow {
  id: string;
  session_id: string | null;
  message_id: string | null;
  kind: string;
  path: string | null;
  uri: string | null;
  hash: string | null;
  bytes: number | null;
  created_at: string;
  metadata: string | null;
}

interface BusMessageRow {
  seq: number;
  id: string;
  channel: string;
  sender: string;
  content: string;
  refs: string | null;
  created_at: string;
}

function rowToBusMessage(r: BusMessageRow): BusMessage {
  return {
    seq: r.seq,
    id: r.id,
    channel: r.channel,
    sender: r.sender,
    content: r.content,
    ...(r.refs !== null ? { refs: JSON.parse(r.refs) as string[] } : {}),
    createdAt: r.created_at,
  };
}

function rowToArtifact(r: ArtifactRow): Artifact {
  return {
    id: r.id,
    ...(r.session_id !== null ? { sessionId: r.session_id } : {}),
    ...(r.message_id !== null ? { messageId: r.message_id } : {}),
    kind: r.kind as Artifact['kind'],
    ...(r.path !== null ? { path: r.path } : {}),
    ...(r.uri !== null ? { uri: r.uri } : {}),
    ...(r.hash !== null ? { hash: r.hash } : {}),
    ...(r.bytes !== null ? { bytes: r.bytes } : {}),
    createdAt: r.created_at,
    ...(r.metadata !== null ? { metadata: JSON.parse(r.metadata) as Record<string, unknown> } : {}),
  };
}

export class OmcStore {
  readonly dbPath: string;
  private readonly db: Database.Database;

  constructor(opts: StoreOptions = {}) {
    this.dbPath = opts.dbPath ?? join(opts.home ?? omcHome(), 'omc.db');
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  ingest(events: unknown[]): IngestResult {
    const valid: { event: OmcEvent; raw: string }[] = [];
    const errors: IngestError[] = [];
    let unknown = 0;
    for (let i = 0; i < events.length; i++) {
      // loose envelope first: unknown `type` values are skipped (schema.md §3),
      // never fatal; only malformed envelopes and failed entity validation count as errors
      const env = EventEnvelopeSchema.safeParse(events[i]);
      if (!env.success) {
        const issue = env.error.issues[0];
        errors.push({
          index: i,
          error: `${issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid event'}`.slice(0, 300),
        });
        continue;
      }
      if (env.data.type !== 'session' && env.data.type !== 'message' && env.data.type !== 'artifact') {
        unknown++;
        continue;
      }
      const res = OmcEventSchema.safeParse(events[i]);
      if (res.success) {
        const e = res.data;
        if (e.type === 'session') {
          e.data.startedAt = canonDate(e.data.startedAt);
          if (e.data.endedAt) e.data.endedAt = canonDate(e.data.endedAt);
        } else {
          e.data.createdAt = canonDate(e.data.createdAt);
        }
        valid.push({ event: e, raw: JSON.stringify(e) });
      } else {
        const issue = res.error.issues[0];
        errors.push({
          index: i,
          error: `${issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid event'}`.slice(0, 300),
        });
      }
    }
    if (valid.length === 0) return { ingested: 0, skipped: 0, unknown, errors };
    const run = this.db.transaction((rows: { event: OmcEvent; raw: string }[]) => {
      let ingested = 0;
      let skipped = 0;
      for (const { event, raw } of rows) {
        if (this.applyEvent(event, raw)) ingested++;
        else skipped++;
      }
      return { ingested, skipped };
    });
    const { ingested, skipped } = run(valid);
    return { ingested, skipped, unknown, errors };
  }

  private applyEvent(event: OmcEvent, raw: string): boolean {
    switch (event.type) {
      case 'session':
        return this.applySession(event.data, raw);
      case 'message':
        return this.applyMessage(event.data, raw);
      case 'artifact':
        return this.applyArtifact(event.data, raw);
    }
  }

  private applySession(d: Session, raw: string): boolean {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO sessions (id, source, external_id, title, cwd, started_at, ended_at, model, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        d.id,
        d.source,
        d.externalId,
        d.title ?? null,
        d.cwd ?? null,
        d.startedAt,
        d.endedAt ?? null,
        d.model ?? null,
        d.metadata ? JSON.stringify(d.metadata) : null,
      );
    if (info.changes > 0) {
      this.appendEvent('session', d.id, d.id, raw);
      return true;
    }
    const before = this.db
      .prepare('SELECT title, cwd, started_at, ended_at, model FROM sessions WHERE id = ?')
      .get(d.id) as unknown;
    this.db
      .prepare(
        `UPDATE sessions SET
           title = COALESCE(sessions.title, ?),
           cwd = COALESCE(sessions.cwd, ?),
           started_at = MIN(sessions.started_at, ?),
           ended_at = CASE
             WHEN sessions.ended_at IS NULL THEN ?
             WHEN ? IS NULL THEN sessions.ended_at
             ELSE MAX(sessions.ended_at, ?) END,
           model = COALESCE(sessions.model, ?)
         WHERE id = ?`,
      )
      .run(d.title ?? null, d.cwd ?? null, d.startedAt, d.endedAt ?? null, d.endedAt ?? null, d.endedAt ?? null, d.model ?? null, d.id);
    const after = this.db
      .prepare('SELECT title, cwd, started_at, ended_at, model FROM sessions WHERE id = ?')
      .get(d.id) as unknown;
    // a merge that added information must stay visible in the event log,
    // or jsonl export/re-ingest loses it
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      this.appendEvent('session', d.id, d.id, raw);
    }
    return false;
  }

  private applyMessage(d: Message, raw: string): boolean {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO messages
           (id, session_id, role, content, content_type, created_at, model, token_input, token_output, parent_id, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        d.id,
        d.sessionId,
        d.role,
        d.content,
        d.contentType,
        d.createdAt,
        d.model ?? null,
        d.tokenUsage?.input ?? null,
        d.tokenUsage?.output ?? null,
        d.parentId ?? null,
        d.metadata ? JSON.stringify(d.metadata) : null,
      );
    if (info.changes > 0) {
      this.appendEvent('message', d.id, d.sessionId, raw);
      return true;
    }
    return false;
  }

  private applyArtifact(d: Artifact, raw: string): boolean {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO artifacts (id, session_id, message_id, kind, path, uri, hash, bytes, created_at, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        d.id,
        d.sessionId ?? null,
        d.messageId ?? null,
        d.kind,
        d.path ?? null,
        d.uri ?? null,
        d.hash ?? null,
        d.bytes ?? null,
        d.createdAt,
        d.metadata ? JSON.stringify(d.metadata) : null,
      );
    if (info.changes > 0) {
      this.appendEvent('artifact', d.id, d.sessionId ?? null, raw);
      return true;
    }
    return false;
  }

  private appendEvent(type: string, id: string, sessionId: string | null, raw: string): void {
    this.db
      .prepare('INSERT INTO events (id, type, session_id, raw) VALUES (?, ?, ?, ?)')
      .run(id, type, sessionId, raw);
  }

  private searchWhere(opts: SearchOptions): { clause: string; params: (string | number)[] } {
    let clause = '';
    const params: (string | number)[] = [];
    if (opts.source) {
      clause += ' AND s.source = ?';
      params.push(opts.source);
    }
    if (opts.since) {
      clause += ' AND m.created_at >= ?';
      params.push(opts.since);
    }
    if (opts.until) {
      clause += ' AND m.created_at <= ?';
      params.push(opts.until);
    }
    return { clause, params };
  }

  search(query: string, opts: SearchOptions = {}): SearchHit[] {
    const match = toFtsQuery(query);
    if (!match) return [];
    const limit = opts.limit ?? 20;
    const offset = opts.offset ?? 0;
    const { clause, params } = this.searchWhere(opts);
    const sql = `
      SELECT m.id, m.session_id AS sessionId, m.role, m.content, m.content_type AS contentType,
             m.created_at AS createdAt, s.source, s.cwd, s.title,
             snippet(messages_fts, 0, '', '', ' … ', 12) AS snippet
      FROM messages_fts
      JOIN messages m ON m.rowid = messages_fts.rowid
      LEFT JOIN sessions s ON s.id = m.session_id
      WHERE messages_fts MATCH ?${clause}
      ORDER BY bm25(messages_fts)
      LIMIT ? OFFSET ?`;
    try {
      return this.db.prepare(sql).all(match, ...params, limit, offset) as unknown as SearchHit[];
    } catch {
      return [];
    }
  }

  countSearch(query: string, opts: SearchOptions = {}): number {
    const match = toFtsQuery(query);
    if (!match) return 0;
    const { clause, params } = this.searchWhere(opts);
    const sql = `
      SELECT COUNT(*) AS c
      FROM messages_fts
      JOIN messages m ON m.rowid = messages_fts.rowid
      LEFT JOIN sessions s ON s.id = m.session_id
      WHERE messages_fts MATCH ?${clause}`;
    try {
      return (this.db.prepare(sql).get(match, ...params) as { c: number }).c;
    } catch {
      return 0;
    }
  }

  private sessionWhere(opts: SessionListOptions): { clause: string; params: (string | number)[] } {
    const conds: string[] = [];
    const params: (string | number)[] = [];
    if (opts.source) {
      conds.push('s.source = ?');
      params.push(opts.source);
    }
    if (opts.since) {
      conds.push('s.started_at >= ?');
      params.push(opts.since);
    }
    if (opts.until) {
      conds.push('s.started_at <= ?');
      params.push(opts.until);
    }
    return { clause: conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '', params };
  }

  listSessions(opts: SessionListOptions = {}): SessionSummary[] {
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    const { clause, params } = this.sessionWhere(opts);
    const rows = this.db
      .prepare(
        `SELECT s.*, COUNT(m.id) AS message_count,
           (SELECT substr(mu.content, 1, 160) FROM messages mu
            WHERE mu.session_id = s.id AND mu.role = 'user'
            ORDER BY mu.created_at, mu.rowid LIMIT 1) AS first_user_preview
         FROM sessions s LEFT JOIN messages m ON m.session_id = s.id
         ${clause}
         GROUP BY s.id
         ORDER BY s.started_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as unknown as (SessionRow & {
      message_count: number;
      first_user_preview: string | null;
    })[];
    return rows.map((r) => ({
      ...rowToSession(r),
      messageCount: r.message_count,
      firstUserPreview: r.first_user_preview,
    }));
  }

  sessionCount(opts: SessionListOptions = {}): number {
    const { clause, params } = this.sessionWhere(opts);
    return (this.db.prepare(`SELECT COUNT(*) AS c FROM sessions s ${clause}`).get(...params) as { c: number }).c;
  }

  recentSessions(opts: { since: string; source?: string; limit?: number; offset?: number }): {
    sessions: RecentSession[];
    total: number;
  } {
    const limit = opts.limit ?? 20;
    const offset = opts.offset ?? 0;
    // aggregate only the window's messages (driven by idx_messages_created),
    // then hydrate session rows + last-message previews via indexed lookups
    // for the returned page only — never scan all messages per session
    const sourceJoin = opts.source ? 'JOIN sessions s0 ON s0.id = m.session_id AND s0.source = ?' : '';
    // INDEXED BY: the planner otherwise picks idx_messages_session for the
    // GROUP BY and scans every message ever, ignoring the tiny time window
    const agg = `FROM messages m INDEXED BY idx_messages_created ${sourceJoin} WHERE m.created_at >= ? GROUP BY m.session_id`;
    const baseParams: (string | number)[] = opts.source ? [opts.source, opts.since] : [opts.since];
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS c FROM (SELECT m.session_id ${agg})`).get(...baseParams) as { c: number }
    ).c;
    const rows = this.db
      .prepare(
        `SELECT m.session_id AS sid, COUNT(*) AS window_count, MAX(m.created_at) AS last_activity
         ${agg}
         ORDER BY last_activity DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...baseParams, limit, offset) as unknown as {
      sid: string;
      window_count: number;
      last_activity: string;
    }[];
    const sessStmt = this.db.prepare('SELECT * FROM sessions WHERE id = ?');
    const lastStmt = this.db.prepare(
      'SELECT role, substr(content, 1, 240) AS preview FROM messages WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    );
    const sessions: RecentSession[] = [];
    for (const r of rows) {
      const s = sessStmt.get(r.sid) as SessionRow | undefined;
      if (!s) continue;
      const last = lastStmt.get(r.sid) as { role: string; preview: string | null } | undefined;
      sessions.push({
        ...rowToSession(s),
        messageCount: r.window_count,
        firstUserPreview: null,
        lastActivity: r.last_activity,
        lastMessageRole: last?.role ?? null,
        lastMessagePreview: last?.preview ?? null,
      });
    }
    return { sessions, total };
  }

  resolveSessionId(idOrPrefix: string): string | null {
    const exact = this.db.prepare('SELECT id FROM sessions WHERE id = ?').get(idOrPrefix) as
      | { id: string }
      | undefined;
    if (exact) return exact.id;
    const rows = this.db
      .prepare('SELECT id FROM sessions WHERE id LIKE ? ORDER BY started_at DESC LIMIT 2')
      .all(`${idOrPrefix}%`) as unknown as { id: string }[];
    return rows.length === 1 ? (rows[0]?.id ?? null) : null;
  }

  /**
   * Attribution heuristic for filesystem artifacts: the most specific session
   * whose cwd is a path prefix of `dir` and whose [startedAt, endedAt+30min]
   * window (open-ended while the session has no endedAt) contains `mtimeIso`.
   */
  attributeSessionId(dir: string, mtimeIso: string): string | null {
    const row = this.db
      .prepare(
        `SELECT id FROM sessions
         WHERE cwd IS NOT NULL
           AND substr(?, 1, length(cwd)) = cwd
           AND (length(?) = length(cwd) OR substr(?, length(cwd) + 1, 1) = '/')
           AND started_at <= ?
           AND strftime('%Y-%m-%dT%H:%M:%fZ', COALESCE(ended_at, 'now'), '+30 minutes') >= ?
         ORDER BY length(cwd) DESC, started_at DESC
         LIMIT 1`,
      )
      .get(dir, dir, dir, mtimeIso, mtimeIso) as { id: string } | undefined;
    return row?.id ?? null;
  }

  getSessions(filter: { sessionId?: string } = {}): Session[] {
    const rows = (
      filter.sessionId
        ? this.db.prepare('SELECT * FROM sessions WHERE id = ?').all(filter.sessionId)
        : this.db.prepare('SELECT * FROM sessions ORDER BY started_at').all()
    ) as unknown as SessionRow[];
    return rows.map(rowToSession);
  }

  private messageWhere(filter: MessageFilter): { clause: string; params: (string | number)[] } {
    const conds: string[] = [];
    const params: (string | number)[] = [];
    if (filter.sessionId) {
      conds.push('session_id = ?');
      params.push(filter.sessionId);
    }
    if (filter.roles && filter.roles.length > 0) {
      conds.push(`role IN (${filter.roles.map(() => '?').join(', ')})`);
      params.push(...filter.roles);
    }
    return { clause: conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '', params };
  }

  getMessages(filter: MessageFilter = {}): Message[] {
    const { clause, params } = this.messageWhere(filter);
    const page = filter.limit !== undefined ? ' LIMIT ? OFFSET ?' : '';
    if (filter.limit !== undefined) params.push(filter.limit, filter.offset ?? 0);
    const rows = this.db
      .prepare(`SELECT * FROM messages ${clause} ORDER BY created_at, rowid${page}`)
      .all(...params) as unknown as MessageRow[];
    return rows.map(rowToMessage);
  }

  messageCount(filter: MessageFilter = {}): number {
    const { clause, params } = this.messageWhere(filter);
    return (this.db.prepare(`SELECT COUNT(*) AS c FROM messages ${clause}`).get(...params) as { c: number }).c;
  }

  private artifactWhere(filter: ArtifactFilter): { clause: string; params: (string | number)[] } {
    const conds: string[] = [];
    const params: (string | number)[] = [];
    if (filter.sessionId) {
      conds.push('session_id = ?');
      params.push(filter.sessionId);
    }
    if (filter.kind) {
      conds.push('kind = ?');
      params.push(filter.kind);
    }
    if (filter.pathPrefix) {
      conds.push(`path LIKE ? ESCAPE '\\'`);
      params.push(`${likeEscape(filter.pathPrefix)}%`);
    }
    return { clause: conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '', params };
  }

  getArtifacts(filter: ArtifactFilter = {}): Artifact[] {
    const { clause, params } = this.artifactWhere(filter);
    const page = filter.limit !== undefined ? ' LIMIT ? OFFSET ?' : '';
    if (filter.limit !== undefined) params.push(filter.limit, filter.offset ?? 0);
    const rows = this.db
      .prepare(`SELECT * FROM artifacts ${clause} ORDER BY created_at, rowid${page}`)
      .all(...params) as unknown as ArtifactRow[];
    return rows.map(rowToArtifact);
  }

  artifactCount(filter: ArtifactFilter = {}): number {
    const { clause, params } = this.artifactWhere(filter);
    return (this.db.prepare(`SELECT COUNT(*) AS c FROM artifacts ${clause}`).get(...params) as { c: number }).c;
  }

  allEvents(filter: { sessionId?: string } = {}): OmcEvent[] {
    return this.rawEvents(filter).map((raw) => JSON.parse(raw) as OmcEvent);
  }

  rawEvents(filter: { sessionId?: string } = {}): string[] {
    const rows = (
      filter.sessionId
        ? this.db
            .prepare('SELECT raw FROM events WHERE session_id = ? OR id = ? ORDER BY seq')
            .all(filter.sessionId, filter.sessionId)
        : this.db.prepare('SELECT raw FROM events ORDER BY seq').all()
    ) as unknown as { raw: string }[];
    return rows.map((r) => r.raw);
  }

  stats(): StoreStats {
    const count = (sql: string): number => (this.db.prepare(sql).get() as { c: number }).c;
    const sourceRows = this.db
      .prepare(
        `SELECT src.source,
                src.sessions,
                COALESCE(msg.messages, 0) AS messages,
                COALESCE(art.artifacts, 0) AS artifacts
         FROM (SELECT source, COUNT(*) AS sessions FROM sessions GROUP BY source) src
         LEFT JOIN (
           SELECT s.source, COUNT(*) AS messages
           FROM messages m JOIN sessions s ON s.id = m.session_id GROUP BY s.source
         ) msg ON msg.source = src.source
         LEFT JOIN (
           SELECT s.source, COUNT(*) AS artifacts
           FROM artifacts a JOIN sessions s ON s.id = a.session_id GROUP BY s.source
         ) art ON art.source = src.source
         ORDER BY src.source`,
      )
      .all() as unknown as SourceStat[];
    const range = this.db
      .prepare(
        `SELECT MIN(c) AS earliest, MAX(c) AS latest FROM (
           SELECT created_at AS c FROM messages
           UNION ALL SELECT created_at FROM artifacts
         )`,
      )
      .get() as { earliest: string | null; latest: string | null };
    return {
      version: OMC_VERSION,
      dbPath: this.dbPath,
      dbBytes: this.dbBytes(),
      totals: {
        sessions: count('SELECT COUNT(*) AS c FROM sessions'),
        messages: count('SELECT COUNT(*) AS c FROM messages'),
        artifacts: count('SELECT COUNT(*) AS c FROM artifacts'),
        events: count('SELECT COUNT(*) AS c FROM events'),
      },
      sources: sourceRows,
      earliest: range.earliest,
      latest: range.latest,
    };
  }

  private dbBytes(): number {
    let bytes = 0;
    for (const suffix of ['', '-wal']) {
      try {
        bytes += statSync(this.dbPath + suffix).size;
      } catch {
        // file may not exist yet
      }
    }
    return bytes;
  }

  getSyncState(source: string, filePath: string): SyncState | undefined {
    const row = this.db
      .prepare('SELECT source, file_path, byte_offset, mtime FROM sync_state WHERE source = ? AND file_path = ?')
      .get(source, filePath) as
      | { source: string; file_path: string; byte_offset: number; mtime: number }
      | undefined;
    if (!row) return undefined;
    return { source: row.source, filePath: row.file_path, byteOffset: row.byte_offset, mtime: row.mtime };
  }

  setSyncState(source: string, filePath: string, byteOffset: number, mtime: number): void {
    this.db
      .prepare(
        `INSERT INTO sync_state (source, file_path, byte_offset, mtime) VALUES (?, ?, ?, ?)
         ON CONFLICT(source, file_path) DO UPDATE SET byte_offset = excluded.byte_offset, mtime = excluded.mtime`,
      )
      .run(source, filePath, byteOffset, mtime);
  }

  postBusMessage(input: {
    channel: string;
    sender: string;
    content: string;
    refs?: string[];
    clientMsgId?: string;
  }): { seq: number; id: string; duplicate: boolean } {
    const createdAt = new Date().toISOString();
    const id = input.clientMsgId
      ? sha256Hex(`bus:${input.sender}:${input.clientMsgId}`)
      : sha256Hex(`bus:${input.sender}:${createdAt}:${sha256Hex(input.content)}`);
    const sessionExtId = `bus:${input.channel}`;
    const run = this.db.transaction(() => {
      const info = this.db
        .prepare(
          'INSERT OR IGNORE INTO bus_messages (id, channel, sender, content, refs, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          id,
          input.channel,
          input.sender,
          input.content,
          input.refs && input.refs.length > 0 ? JSON.stringify(input.refs) : null,
          createdAt,
        );
      if (info.changes === 0) {
        const existing = this.db.prepare('SELECT seq FROM bus_messages WHERE id = ?').get(id) as
          | { seq: number }
          | undefined;
        return { seq: existing?.seq ?? 0, id, duplicate: true };
      }
      const seq = Number(info.lastInsertRowid);
      // mirror into the context store so bus traffic is searchable/exportable;
      // ingest() opens a nested transaction (savepoint) inside this one
      const sid = sessionId(BUS_SOURCE, sessionExtId);
      this.ingest([
        {
          v: 1,
          type: 'session',
          data: {
            id: sid,
            source: BUS_SOURCE,
            externalId: sessionExtId,
            title: `#${input.channel}`,
            startedAt: createdAt,
            endedAt: createdAt,
          },
        },
        {
          v: 1,
          type: 'message',
          data: {
            id: messageId(BUS_SOURCE, sessionExtId, id),
            sessionId: sid,
            role: 'user',
            content: input.content,
            contentType: 'text',
            createdAt,
            metadata: {
              sender: input.sender,
              ...(input.refs && input.refs.length > 0 ? { refs: input.refs } : {}),
            },
          },
        },
      ]);
      return { seq, id, duplicate: false };
    });
    return run();
  }

  readBusMessages(opts: {
    channel?: string;
    afterSeq?: number;
    since?: string;
    limit?: number;
  }): { messages: BusMessage[]; latestSeq: number; truncated: boolean } {
    const conds: string[] = [];
    const params: (string | number)[] = [];
    if (opts.channel) {
      conds.push('channel = ?');
      params.push(opts.channel);
    }
    if (opts.afterSeq !== undefined) {
      conds.push('seq > ?');
      params.push(opts.afterSeq);
    }
    if (opts.since) {
      conds.push('created_at >= ?');
      params.push(opts.since);
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    const limit = opts.limit ?? 100;
    // fetch one extra row to know whether the page is truncated
    const rows = this.db
      .prepare(`SELECT * FROM bus_messages ${where} ORDER BY seq LIMIT ?`)
      .all(...params, limit + 1) as unknown as BusMessageRow[];
    const truncated = rows.length > limit;
    if (truncated) rows.length = limit;
    const latest = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM bus_messages').get() as { s: number };
    return { messages: rows.map(rowToBusMessage), latestSeq: latest.s, truncated };
  }

  listBusChannels(): BusChannelInfo[] {
    const rows = this.db
      .prepare(
        `SELECT channel, COUNT(*) AS count, MAX(created_at) AS last_activity,
                json_group_array(DISTINCT sender) AS senders
         FROM bus_messages GROUP BY channel ORDER BY last_activity DESC`,
      )
      .all() as unknown as { channel: string; count: number; last_activity: string; senders: string }[];
    return rows.map((r) => ({
      channel: r.channel,
      count: r.count,
      lastActivity: r.last_activity,
      senders: (JSON.parse(r.senders) as string[]).sort(),
    }));
  }
}
