import { browser } from 'wxt/browser';

const DEFAULT_DAEMON_URL = 'http://127.0.0.1:27182';

interface DiagEntry {
  time: string;
  kind: string;
  text: string;
}

interface SiteDiag {
  entries?: DiagEntry[];
  /** legacy field from older builds */
  requests?: string[];
  captures: number;
  lastSuccess: number | null;
  lastError: string | null;
  hookActiveAt?: number | null;
  hookHost?: string | null;
}

const KIND_COLOR: Record<string, string> = {
  request: '#666',
  captured: '#1a7f37',
  error: '#cf222e',
  'hook-active': '#1a1a7f',
  stream: '#7c5a10',
};

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

function showTab(diag: boolean): void {
  $('pageStatus').hidden = diag;
  $('pageDiag').hidden = !diag;
  $('tabStatus').classList.toggle('active', !diag);
  $('tabDiag').classList.toggle('active', diag);
}

async function refresh(): Promise<void> {
  const sync = await browser.storage.sync.get({
    omcDaemonUrl: DEFAULT_DAEMON_URL,
    omcCaptureEnabled: true,
  });
  const local = await browser.storage.local.get({ omcEventsSent: 0, omcQueue: [], omcDiag: {} });
  ($('daemonUrl') as HTMLInputElement).value = String(sync.omcDaemonUrl);
  ($('enabled') as HTMLInputElement).checked = Boolean(sync.omcCaptureEnabled);
  $('sent').textContent = String(local.omcEventsSent ?? 0);
  $('queued').textContent = String(Array.isArray(local.omcQueue) ? local.omcQueue.length : 0);
  const daemonDiag = (local.omcDiag as Record<string, SiteDiag>)._daemon;
  const last = daemonDiag?.lastSuccess
    ? `ok · ${new Date(daemonDiag.lastSuccess).toLocaleTimeString()}`
    : daemonDiag?.lastError
      ? `failed · ${daemonDiag.lastError}`
      : '—';
  $('lastDelivery').textContent = last;

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

async function refreshDiag(): Promise<void> {
  const local = await browser.storage.local.get({ omcDiag: {} });
  const diag = local.omcDiag as Record<string, SiteDiag>;
  const host = $('diagSites');
  const sites = Object.entries(diag).sort(([a], [b]) => (a === '_daemon' ? -1 : b === '_daemon' ? 1 : a < b ? -1 : 1));
  if (sites.length === 0) {
    host.innerHTML = '<div class="muted">no captures observed yet — open a supported AI chat and send a message</div>';
    return;
  }
  host.innerHTML = sites
    .map(([site, d]) => {
      const lastOk = d.lastSuccess ? new Date(d.lastSuccess).toLocaleString() : 'never';
      const hook = d.hookActiveAt
        ? `hook active on ${escapeHtml(d.hookHost ?? '?')} since ${new Date(d.hookActiveAt).toLocaleString()}`
        : 'no hook heartbeat seen';
      const entries = (d.entries ?? [])
        .slice()
        .reverse()
        .map(
          (e) =>
            `<div><span class="kind" style="color:${KIND_COLOR[e.kind] ?? '#666'}">${escapeHtml(e.kind)}</span> <span class="muted">${escapeHtml(e.time)}</span> ${escapeHtml(e.text)}</div>`,
        )
        .join('');
      const legacyReqs = (d.requests ?? []).map((r) => `<div>${escapeHtml(r)}</div>`).join('');
      const body = entries || legacyReqs || '<div class="muted">no API traffic seen</div>';
      const title = site === '_daemon' ? 'daemon delivery' : site;
      return `<div class="site">
        <h2>${escapeHtml(title)}</h2>
        <div class="muted">${escapeHtml(hook)} · captures: ${d.captures} · last delivery: ${escapeHtml(lastOk)}</div>
        ${d.lastError ? `<div class="muted" style="color:#cf222e">last error: ${escapeHtml(d.lastError)}</div>` : ''}
        <div class="reqs">${body}</div>
      </div>`;
    })
    .join('');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

async function copyDiag(): Promise<void> {
  const local = await browser.storage.local.get({ omcDiag: {} });
  const text = JSON.stringify(local.omcDiag, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    $('copyState').textContent = 'copied to clipboard';
  } catch {
    $('copyState').textContent = 'clipboard blocked — open devtools console instead';
    console.log(text);
  }
}

$('tabStatus').addEventListener('click', () => showTab(false));
$('tabDiag').addEventListener('click', () => {
  showTab(true);
  void refreshDiag();
});
$('save').addEventListener('click', () => void save());
$('captureNow').addEventListener('click', () => void captureNow());
$('copyDiag').addEventListener('click', () => void copyDiag());
void refresh();
