import { api } from '../api';
import { emptyState, errorBanner, esc, fmtTime, highlight, loading } from '../util';

export async function renderSearch(root: HTMLElement, query: URLSearchParams): Promise<void> {
  const q = query.get('q') ?? '';
  const source = query.get('source') ?? '';
  try {
    const ov = await api.overview();
    const options = [
      `<option value="">all sources</option>`,
      ...ov.sources.map(
        (s) => `<option value="${esc(s.source)}"${s.source === source ? ' selected' : ''}>${esc(s.source)}</option>`,
      ),
    ].join('');
    root.innerHTML = `
      <h2>Search</h2>
      <div class="toolbar">
        <input type="search" id="q" placeholder="search every captured conversation…" value="${esc(q)}" size="42" />
        <select id="sourceFilter">${options}</select>
        <button id="go">search</button>
      </div>
      <div id="results"></div>
    `;
    const submit = () => {
      const nq = (root.querySelector('#q') as HTMLInputElement).value.trim();
      const ns = (root.querySelector('#sourceFilter') as HTMLSelectElement).value;
      const params = new URLSearchParams();
      if (nq) params.set('q', nq);
      if (ns) params.set('source', ns);
      location.hash = `#/search${params.size ? `?${params}` : ''}`;
    };
    root.querySelector('#go')?.addEventListener('click', submit);
    root.querySelector('#q')?.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') submit();
    });
    root.querySelector('#sourceFilter')?.addEventListener('change', submit);
    if (!q) return;
    const results = root.querySelector('#results')!;
    loading(results);
    const res = await api.search(q, source, 50, 0);
    results.innerHTML =
      res.hits.length === 0
        ? emptyState(`no matches for "${esc(q)}"`)
        : `<p class="dim small">${res.total} hit(s)${res.total > res.hits.length ? `, showing first ${res.hits.length}` : ''}</p>` +
          res.hits
            .map(
              (h) => `<a class="hit-row" href="#/sessions/${h.sessionId}">
                <span class="badge">${esc(h.source ?? '?')}</span>
                <span class="dim small">${esc(h.role)} · <span class="mono">${esc(fmtTime(h.createdAt))}</span> · ${esc(h.sessionTitle ?? h.sessionCwd ?? '')}</span><br />
                <span>${highlight(h.snippet, q)}</span>
              </a>`,
            )
            .join('');
  } catch (err) {
    errorBanner(root, err);
  }
}
