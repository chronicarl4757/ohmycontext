import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';

// Owns the network path to the local daemon. Batches normalized events into
// JSONL POSTs; when the daemon is unreachable, queues lines in storage.local
// (FIFO, ~5MB cap) and retries with backoff (plus a 1-minute alarm as a
// safety net against MV3 service-worker suspension).

const DEFAULT_DAEMON_URL = 'http://127.0.0.1:27182';
const QUEUE_KEY = 'omcQueue';
const SENT_KEY = 'omcEventsSent';
const QUEUE_MAX_BYTES = 5 * 1024 * 1024;
const FLUSH_DELAY_MS = 3000;
const BACKOFF_MIN_MS = 5000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;

export default defineBackground(() => {
  let pending: string[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let backoffMs = BACKOFF_MIN_MS;
  let flushing = false;

  browser.runtime.onMessage.addListener((msg: unknown) => {
    const m = msg as { type?: string; events?: unknown[] } | null;
    if (m?.type !== 'omc-events' || !Array.isArray(m.events)) return;
    for (const e of m.events) {
      try {
        pending.push(JSON.stringify(e));
      } catch {
        // unserializable event; drop it
      }
    }
    scheduleFlush(FLUSH_DELAY_MS);
  });

  function scheduleFlush(delay: number): void {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, delay);
  }

  async function getQueue(): Promise<string[]> {
    const v = await browser.storage.local.get({ [QUEUE_KEY]: [] });
    return Array.isArray(v[QUEUE_KEY]) ? (v[QUEUE_KEY] as string[]) : [];
  }

  async function daemonUrl(): Promise<string> {
    const v = await browser.storage.sync.get({ omcDaemonUrl: DEFAULT_DAEMON_URL });
    return String(v.omcDaemonUrl || DEFAULT_DAEMON_URL).replace(/\/+$/, '');
  }

  async function flush(): Promise<void> {
    if (flushing) return;
    flushing = true;
    try {
      const queued = await getQueue();
      const lines = [...queued, ...pending];
      if (lines.length === 0) return;
      const res = await fetch(`${await daemonUrl()}/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-ndjson' },
        body: `${lines.join('\n')}\n`,
      });
      if (!res.ok) throw new Error(`http ${res.status}`);
      pending = [];
      backoffMs = BACKOFF_MIN_MS;
      await browser.storage.local.set({ [QUEUE_KEY]: [] });
      const sent = await browser.storage.local.get({ [SENT_KEY]: 0 });
      await browser.storage.local.set({ [SENT_KEY]: Number(sent[SENT_KEY] ?? 0) + lines.length });
    } catch {
      const queued = await getQueue();
      const all = [...queued, ...pending];
      pending = [];
      let bytes = all.reduce((n, l) => n + l.length + 1, 0);
      while (bytes > QUEUE_MAX_BYTES && all.length > 0) {
        bytes -= all[0].length + 1;
        all.shift();
      }
      await browser.storage.local.set({ [QUEUE_KEY]: all });
      scheduleFlush(backoffMs);
      backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
    } finally {
      flushing = false;
    }
  }

  // wake-up paths: retry whatever is queued whenever the worker spins up
  browser.runtime.onStartup.addListener(() => void flush());
  browser.alarms.onAlarm.addListener((a) => {
    if (a.name === 'omc-flush') void flush();
  });
  void browser.alarms.create('omc-flush', { periodInMinutes: 1 });
  void flush();
});
