import { getRequestListener } from '@hono/node-server';
import { watch, type FSWatcher } from 'chokidar';
import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join, resolve, sep } from 'node:path';
import { OmcStore } from '@ohmycontext/core';
import { defaultConnectors, type Connector } from '@ohmycontext/connectors';
import { scanArtifactDirs, watchArtifactDirs, FS_ARTIFACT_SOURCE } from './artifacts.js';
import { createApp, handleMcpHttp, isAllowedLocalRequest } from './server.js';

export const DEFAULT_PORT = 27182;
const DEBOUNCE_MS = 500;
const RETRY_MISSING_MS = 15_000;

export interface DaemonOptions {
  once?: boolean;
  port?: number;
  home?: string;
  dbPath?: string;
  connectors?: Connector[];
  onLog?: (msg: string) => void;
}

export interface SourceScanSummary {
  files: number;
  filesChanged: number;
  events: number;
  ingested: number;
  skipped: number;
  errors: number;
}

export interface ScanSummary extends SourceScanSummary {
  durationMs: number;
  perSource: Record<string, SourceScanSummary>;
}

function emptySourceSummary(): SourceScanSummary {
  return { files: 0, filesChanged: 0, events: 0, ingested: 0, skipped: 0, errors: 0 };
}

async function* walkJsonl(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // missing or unreadable dir
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    try {
      if (e.isDirectory()) yield* walkJsonl(p);
      else if (e.isFile() && e.name.endsWith('.jsonl')) yield p;
    } catch {
      // entry vanished mid-walk; skip
    }
  }
}

export class Daemon {
  readonly store: OmcStore;
  private readonly connectors: Connector[];
  private readonly port: number;
  private readonly log: (msg: string) => void;
  private readonly startedAt = Date.now();
  private watcher: FSWatcher | null = null;
  private artifactWatcher: FSWatcher | null = null;
  private server: Server | null = null;
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private readonly debouncers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly missing = new Map<string, Connector>();

  constructor(opts: {
    store: OmcStore;
    connectors: Connector[];
    port: number;
    onLog: (msg: string) => void;
  }) {
    this.store = opts.store;
    this.connectors = opts.connectors;
    this.port = opts.port;
    this.log = opts.onLog;
  }

  private connectorForPath(p: string): Connector | null {
    let best: Connector | null = null;
    let bestLen = -1;
    for (const c of this.connectors) {
      for (const d of c.dirs()) {
        const rd = resolve(d);
        if (rd.length > bestLen && (p === rd || p.startsWith(rd + sep))) {
          best = c;
          bestLen = rd.length;
        }
      }
    }
    return best;
  }

  async scanFile(connector: Connector, filePath: string): Promise<SourceScanSummary> {
    const out = emptySourceSummary();
    out.files = 1;
    let st;
    try {
      st = await stat(filePath);
    } catch {
      out.files = 0;
      return out;
    }
    const mtime = Math.round(st.mtimeMs);
    const prev = this.store.getSyncState(connector.name, filePath);
    let offset = prev?.byteOffset ?? 0;
    if (offset > st.size) offset = 0; // file truncated or replaced
    if (prev && prev.mtime === mtime && offset === st.size) return out; // unchanged
    out.filesChanged = 1;
    try {
      for (;;) {
        const { events, offset: next } = await connector.parse(filePath, offset);
        if (next <= offset) break; // no complete new line available
        offset = next;
        if (events.length > 0) {
          const r = this.store.ingest(events);
          out.events += events.length;
          out.ingested += r.ingested;
          out.skipped += r.skipped;
          out.errors += r.errors.length;
        }
        if (offset >= st.size) break;
      }
      this.store.setSyncState(connector.name, filePath, offset, mtime);
    } catch (err) {
      out.errors += 1;
      this.log(`scan error ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return out;
  }

  async scanAll(): Promise<ScanSummary> {
    const started = Date.now();
    const total = emptySourceSummary();
    const perSource: Record<string, SourceScanSummary> = {};
    for (const connector of this.connectors) {
      const acc = emptySourceSummary();
      for (const dir of connector.dirs()) {
        for await (const file of walkJsonl(dir)) {
          const r = await this.scanFile(connector, file);
          acc.files += r.files;
          acc.filesChanged += r.filesChanged;
          acc.events += r.events;
          acc.ingested += r.ingested;
          acc.skipped += r.skipped;
          acc.errors += r.errors;
        }
      }
      perSource[connector.name] = acc;
      total.files += acc.files;
      total.filesChanged += acc.filesChanged;
      total.events += acc.events;
      total.ingested += acc.ingested;
      total.skipped += acc.skipped;
      total.errors += acc.errors;
    }
    const art = await scanArtifactDirs(this.store, this.log);
    perSource[FS_ARTIFACT_SOURCE] = {
      files: art.files,
      filesChanged: art.files,
      events: art.artifacts,
      ingested: art.artifacts,
      skipped: 0,
      errors: art.errors,
    };
    total.files += art.files;
    total.filesChanged += art.files;
    total.events += art.artifacts;
    total.ingested += art.artifacts;
    total.errors += art.errors;
    return { ...total, durationMs: Date.now() - started, perSource };
  }

  private onFsEvent(filePath: string): void {
    if (!filePath.endsWith('.jsonl')) return;
    const connector = this.connectorForPath(filePath);
    if (!connector) return;
    const existing = this.debouncers.get(filePath);
    if (existing) clearTimeout(existing);
    this.debouncers.set(
      filePath,
      setTimeout(() => {
        this.debouncers.delete(filePath);
        void this.scanFile(connector, filePath).then((r) => {
          if (r.ingested > 0) this.log(`+${r.ingested} events from ${filePath}`);
        });
      }, DEBOUNCE_MS),
    );
  }

  private checkMissingDirs(): void {
    if (!this.watcher) return;
    for (const [dir, connector] of [...this.missing]) {
      if (!existsSync(dir)) continue;
      this.missing.delete(dir);
      this.watcher.add(dir);
      this.log(`dir appeared, now watching: ${dir} (${connector.name})`);
      void (async () => {
        for await (const file of walkJsonl(dir)) await this.scanFile(connector, file);
      })();
    }
  }

  async start(): Promise<ScanSummary> {
    const summary = await this.scanAll();
    this.log(
      `initial scan: ${summary.ingested} new events from ${summary.filesChanged}/${summary.files} files in ${(summary.durationMs / 1000).toFixed(1)}s`,
    );
    this.watcher = watch([], {
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });
    for (const connector of this.connectors) {
      for (const dir of connector.dirs()) {
        if (existsSync(dir)) {
          this.watcher.add(dir);
          this.log(`watching ${dir} (${connector.name})`);
        } else {
          this.missing.set(dir, connector);
          this.log(`dir missing, retrying every ${RETRY_MISSING_MS / 1000}s: ${dir} (${connector.name})`);
        }
      }
    }
    this.watcher.on('add', (p) => this.onFsEvent(p));
    this.watcher.on('change', (p) => this.onFsEvent(p));
    this.watcher.on('error', (err) =>
      this.log(`watcher error: ${err instanceof Error ? err.message : String(err)}`),
    );
    if (this.missing.size > 0) {
      this.retryTimer = setInterval(() => this.checkMissingDirs(), RETRY_MISSING_MS);
    }
    const app = createApp({ store: this.store, startedAt: this.startedAt, port: this.port });
    this.artifactWatcher = watchArtifactDirs(this.store, this.log);
    const honoListener = getRequestListener(app.fetch);
    this.server = createServer((req, res) => {
      if (req.url && /^\/mcp(?:[/?#]|$)/.test(req.url)) {
        if (!isAllowedLocalRequest(req.headers.host, req.headers.origin, this.port)) {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'forbidden' }));
          return;
        }
        void handleMcpHttp(this.store, req, res);
        return;
      }
      void honoListener(req, res);
    });
    this.server.on('error', (err) => {
      this.log(`http server error: ${err.message}`);
      void this.stop().then(() => process.exit(1));
    });
    this.server.listen(this.port, '127.0.0.1', () => {
      this.log(`http listening on http://127.0.0.1:${this.port} (mcp at /mcp)`);
    });
    return summary;
  }

  async stop(): Promise<void> {
    for (const t of this.debouncers.values()) clearTimeout(t);
    this.debouncers.clear();
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.retryTimer = null;
    if (this.watcher) await this.watcher.close();
    this.watcher = null;
    if (this.artifactWatcher) await this.artifactWatcher.close();
    this.artifactWatcher = null;
    if (this.server) {
      await new Promise<void>((res) => {
        this.server?.close(() => res());
      });
      this.server = null;
    }
  }
}

export async function runDaemon(opts: DaemonOptions = {}): Promise<ScanSummary> {
  const log = opts.onLog ?? ((msg: string) => console.error(`[omc] ${msg}`));
  const store = new OmcStore({ ...(opts.home ? { home: opts.home } : {}), ...(opts.dbPath ? { dbPath: opts.dbPath } : {}) });
  const daemon = new Daemon({
    store,
    connectors: opts.connectors ?? defaultConnectors(),
    port: opts.port ?? (Number(process.env.OMC_PORT) || DEFAULT_PORT),
    onLog: log,
  });
  if (opts.once) {
    try {
      return await daemon.scanAll();
    } finally {
      store.close();
    }
  }
  const summary = await daemon.start();
  await new Promise<void>((resolvePromise) => {
    process.once('SIGINT', () => resolvePromise());
    process.once('SIGTERM', () => resolvePromise());
  });
  log('shutting down…');
  await daemon.stop();
  store.close();
  return summary;
}
