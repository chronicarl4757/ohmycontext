export function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : undefined;
}

export function iso(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

export function minIso(a: string | undefined, b: string): string {
  return a === undefined || b < a ? b : a;
}

export function maxIso(a: string | undefined, b: string): string {
  return a === undefined || b > a ? b : a;
}

export function trunc(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

const PREFERRED_ARG_KEYS = [
  'file_path',
  'notebook_path',
  'path',
  'command',
  'pattern',
  'query',
  'url',
  'prompt',
];

function shortVal(v: unknown): string {
  const s = typeof v === 'string' ? v : (JSON.stringify(v) ?? '');
  return trunc(s.replace(/\s+/g, ' '), 120);
}

export function summarizeInput(input: unknown): string {
  if (input === null || input === undefined) return '';
  if (typeof input !== 'object' || Array.isArray(input)) return trunc(String(input), 120);
  const rec = input as Record<string, unknown>;
  const keys = Object.keys(rec);
  const preferred = PREFERRED_ARG_KEYS.filter((k) => keys.includes(k));
  const use = (preferred.length > 0 ? preferred : keys.slice(0, 3)).slice(0, 4);
  return use.map((k) => `${k}=${shortVal(rec[k])}`).join(', ');
}

export function toolUseText(name: string, input: unknown): string {
  const summary =
    typeof input === 'string'
      ? summarizeArgsString(input)
      : summarizeInput(input);
  return trunc(summary ? `${name}(${summary})` : name, 1000);
}

function summarizeArgsString(args: string): string {
  const t = args.trim();
  if (t.startsWith('{') && t.length < 100_000) {
    try {
      return summarizeInput(JSON.parse(t));
    } catch {
      // not actually JSON; fall through to raw text
    }
  }
  return trunc(t.replace(/\s+/g, ' '), 160);
}

export function tryParseJson(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return v;
  if (t.length > 1_000_000) return v;
  try {
    return JSON.parse(t);
  } catch {
    return v;
  }
}
