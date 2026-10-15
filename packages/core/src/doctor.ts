import type { OmcStore, SourceStat } from './store.js';

export interface DoctorDaemonInfo {
  ok: boolean;
  version?: string;
  uptimeSec?: number;
}

export interface DoctorSyncInfo {
  source: string;
  files: number;
  lastMtime: string | null;
  ageMinutes: number | null;
}

export interface DoctorReport {
  daemon: DoctorDaemonInfo | null;
  port: number;
  db: { path: string; bytes: number; mebibytes: number };
  totals: { sessions: number; messages: number; artifacts: number; events: number };
  earliest: string | null;
  latest: string | null;
  sources: SourceStat[];
  webSources: string[];
  sync: DoctorSyncInfo[];
  hints: string[];
}

/** Shared by `omc doctor` and the daemon's /api/doctor — one source of truth. */
export async function buildDoctorReport(store: OmcStore, port: number): Promise<DoctorReport> {
  let daemon: DoctorDaemonInfo | null = null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    if (res.ok) daemon = (await res.json()) as DoctorDaemonInfo;
  } catch {
    // daemon down
  }
  const st = store.stats();
  const now = Date.now();
  const sync = store.syncStateSummary().map((s) => ({
    source: s.source,
    files: s.files,
    lastMtime: s.lastMtime !== null ? new Date(s.lastMtime).toISOString() : null,
    ageMinutes: s.lastMtime !== null ? Math.round((now - s.lastMtime) / 60_000) : null,
  }));
  const webSources = st.sources.filter((s) => s.source.endsWith('-web')).map((s) => s.source);
  const hints: string[] = [];
  if (!daemon) hints.push('daemon is down — run: omc watch (or omc ui)');
  if (webSources.length === 0) {
    hints.push('no web captures found — load the browser extension (docs/USER_GUIDE.md)');
  }
  for (const s of sync) {
    if (!daemon && s.ageMinutes !== null && s.ageMinutes > 60) {
      hints.push(`sync for '${s.source}' is stale (${s.ageMinutes} min) while daemon is down — run omc watch`);
    }
  }
  return {
    daemon,
    port,
    db: { path: st.dbPath, bytes: st.dbBytes, mebibytes: Math.round((st.dbBytes / 1024 / 1024) * 10) / 10 },
    totals: st.totals,
    earliest: st.earliest,
    latest: st.latest,
    sources: st.sources,
    webSources,
    sync,
    hints,
  };
}
