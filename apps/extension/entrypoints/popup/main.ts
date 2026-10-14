import { browser } from 'wxt/browser';

const DEFAULT_DAEMON_URL = 'http://127.0.0.1:27182';

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

async function refresh(): Promise<void> {
  const sync = await browser.storage.sync.get({
    omcDaemonUrl: DEFAULT_DAEMON_URL,
    omcCaptureEnabled: true,
  });
  const local = await browser.storage.local.get({ omcEventsSent: 0, omcQueue: [] });
  ($('daemonUrl') as HTMLInputElement).value = String(sync.omcDaemonUrl);
  ($('enabled') as HTMLInputElement).checked = Boolean(sync.omcCaptureEnabled);
  $('sent').textContent = String(local.omcEventsSent ?? 0);
  $('queued').textContent = String(Array.isArray(local.omcQueue) ? local.omcQueue.length : 0);

  const dot = $('statusDot');
  const text = $('statusText');
  try {
    const res = await fetch(`${String(sync.omcDaemonUrl).replace(/\/+$/, '')}/health`);
    const body = (await res.json()) as { ok?: boolean; version?: string };
    if (body.ok) {
      dot.className = 'dot ok';
      text.textContent = `daemon online · v${body.version ?? '?'}`;
      return;
    }
    throw new Error('bad response');
  } catch {
    dot.className = 'dot err';
    text.textContent = 'daemon offline (run: omc watch)';
  }
}

async function save(): Promise<void> {
  await browser.storage.sync.set({
    omcDaemonUrl: ($('daemonUrl') as HTMLInputElement).value.trim() || DEFAULT_DAEMON_URL,
    omcCaptureEnabled: ($('enabled') as HTMLInputElement).checked,
  });
  await refresh();
}

async function captureNow(): Promise<void> {
  const out = $('captureResult');
  out.textContent = '';
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      out.textContent = 'no active tab';
      return;
    }
    const res = (await browser.tabs.sendMessage(tab.id, { type: 'omc-capture-now' })) as
      | { ok: boolean; events: number }
      | undefined;
    out.textContent = res ? (res.ok ? `captured ${res.events} events` : 'not a supported chat page') : 'no response';
  } catch {
    out.textContent = 'tab has no omc content script';
  }
}

$('save').addEventListener('click', () => void save());
$('captureNow').addEventListener('click', () => void captureNow());
void refresh();
