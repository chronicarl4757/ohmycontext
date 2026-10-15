import { api, type Overview, type SearchHit } from '../api';
import type { Page } from '../page';
import { emptyState, esc, fmtTime, highlight, sourceBadge } from '../util';

interface SearchParams {
  q: string;
  source: string;
}

interface SearchData {
  ov: Overview;
  q: string;
  hits: SearchHit[] | null;
  total: number;
}

function resultsHtml(hits: SearchHit[], q: string, total: number): string {
  if (hits.length === 0) return emptyState(`没有找到「${esc(q)}」`);
  return (
    `<p class="dim small">${total} 条结果${total > hits.length ? `，显示前 ${hits.length} 条` : ''}</p>` +
    hits
      .map(
        (h) => `<a class="hit-row" href="#/sessions/${h.sessionId}">
          ${sourceBadge(h.source ?? '?')}
          <span class="dim small">${esc(h.role)} · <span class="mono">${esc(fmtTime(h.createdAt))}</span> · ${esc(h.sessionTitle ?? h.sessionCwd ?? '')}</span><br />
          <span>${highlight(h.snippet, q)}</span>
        </a>`,
      )
      .join('')
  );
}

export const page: Page<SearchParams> = {
  key: (p) => `search:${p.q}:${p.source}`,
  load: async (p) => {
    const ov = await api.overview();
    if (!p.q.trim()) return { ov, q: p.q, hits: null, total: 0 } satisfies SearchData;
    const res = await api.search(p.q, p.source, 50, 0);
    return { ov, q: p.q, hits: res.hits, total: res.total } satisfies SearchData;
  },
  view(root, raw, p) {
    const { ov, hits, total } = raw as SearchData;
    const options = [
      `<option value="">全部来源</option>`,
      ...ov.sources.map(
        (s) => `<option value="${esc(s.source)}"${s.source === p.source ? ' selected' : ''}>${esc(s.source)}</option>`,
      ),
    ].join('');
    root.innerHTML = `
      <h2>搜索</h2>
      <div class="toolbar">
        <input type="search" id="q" placeholder="搜索所有 AI 的对话…" value="${esc(p.q)}" size="42" autofocus />
        <select id="sourceFilter">${options}</select>
      </div>
      <div id="results">${hits === null ? emptyState('输入关键词，搜索所有 AI 的对话。') : resultsHtml(hits, p.q, total)}</div>
    `;

    // interactive: debounce + abort in-flight; results render as soon as they land
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let inflight: AbortController | null = null;
    const input = root.querySelector('#q') as HTMLInputElement;
    const select = root.querySelector('#sourceFilter') as HTMLSelectElement;
    const results = root.querySelector('#results')!;
    const runSearch = () => {
      const q = input.value.trim();
      const src = select.value;
      history.replaceState(null, '', `#/search${q ? `?q=${encodeURIComponent(q)}${src ? `&source=${encodeURIComponent(src)}` : ''}` : src ? `?source=${encodeURIComponent(src)}` : ''}`);
      if (inflight) inflight.abort();
      if (!q) {
        results.innerHTML = '';
        return;
      }
      const ac = new AbortController();
      inflight = ac;
      void api
        .search(q, src, 50, 0, ac.signal)
        .then((res) => {
          if (ac.signal.aborted) return;
          results.innerHTML = resultsHtml(res.hits, q, res.total);
        })
        .catch(() => {});
    };
    input.addEventListener('input', () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(runSearch, 300);
    });
    select.addEventListener('change', runSearch);
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      if (inflight) inflight.abort();
    };
  },
};
