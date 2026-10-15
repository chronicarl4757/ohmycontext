export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

export function trunc(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** deterministic pastel-ish hue per sender/source name */
export function hueFor(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

export function errorBanner(root: HTMLElement, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  root.innerHTML = `<div class="error-banner">Could not reach the daemon (${esc(msg)}). Is <code>omc watch</code> running?</div>`;
}

export function loading(root: HTMLElement): void {
  root.innerHTML = '<div class="loading">loading…</div>';
}

export function emptyState(text: string): string {
  return `<div class="empty">${esc(text)}</div>`;
}

export function highlight(snippet: string, query: string): string {
  let out = esc(snippet);
  for (const term of query.split(/\s+/).filter(Boolean)) {
    const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    out = out.replace(re, (m) => `<mark>${m}</mark>`);
  }
  return out;
}

/** zh relative time: 刚刚 / x分钟前 / x小时前 / 昨天 HH:MM / MM-DD */
export function relTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const diffSec = (Date.now() - d.getTime()) / 1000;
  if (diffSec < 60) return '刚刚';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const pad = (n: number) => String(n).padStart(2, '0');
  if (sameDay) return diffSec < 86400 ? `${Math.floor(diffSec / 3600)} 小时前` : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** date-header label for grouping: 今天 / 昨天 / 更早 */
export function dayBucket(iso: string): '今天' | '昨天' | '更早' {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return '今天';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return '昨天';
  return '更早';
}

export function dayLabel(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const FILE_ICON: [RegExp, string][] = [
  [/\.(png|jpe?g|gif|webp|svg|avif)$/i, '🖼'],
  [/\.(zip|tar|gz|7z)$/i, '📦'],
  [/\.(py|ts|tsx|js|mjs|sh|rs|go|c|cpp|java)$/i, '💻'],
  [/\.(md|txt|rst)$/i, '📝'],
  [/\.(jsonl?|ya?ml|toml|xml)$/i, '📋'],
  [/\.(html?|css)$/i, '🌐'],
  [/\.(log)$/i, '📜'],
];

export function fileIcon(path: string | undefined, kind: string): string {
  if (kind === 'image') return '🖼';
  if (kind === 'url') return '🔗';
  if (path) {
    for (const [re, icon] of FILE_ICON) if (re.test(path)) return icon;
  }
  return '📄';
}

