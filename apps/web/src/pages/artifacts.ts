import { api } from '../api';
import { emptyState, errorBanner, esc, fmtBytes, fmtTime, loading, trunc } from '../util';

const PAGE = 50;
const KIND_ICON: Record<string, string> = { file: '📄', url: '🔗', image: '🖼', other: '◻' };

export async function renderArtifacts(root: HTMLElement, query: URLSearchParams): Promise<void> {
  loading(root);
  const kind = query.get('kind') ?? '';
  const pathPrefix = query.get('pathPrefix') ?? '';
  const offset = Math.max(0, Number(query.get('offset') ?? 0) || 0);
  try {
    const res = await api.artifacts(kind, pathPrefix, PAGE, offset);
    const kindOptions = ['', 'file', 'image', 'url', 'other']
      .map((k) => `<option value="${k}"${k === kind ? ' selected' : ''}>${k || 'all kinds'}</option>`)
      .join('');
    const rows = res.artifacts
      .map((a) => {
        const target = a.path ?? a.uri ?? a.id;
        const sess = a.sessionId ? `<a href="#/sessions/${a.sessionId}">session</a>` : '<span class="dim">—</span>';
        return `<tr>
          <td>${KIND_ICON[a.kind] ?? ''} ${esc(a.kind)}</td>
          <td class="mono">${esc(trunc(target, 100))}</td>
          <td class="mono dim">${fmtBytes(a.bytes)}</td>
          <td class="mono dim">${esc(fmtTime(a.createdAt))}</td>
          <td>${sess}</td>
        </tr>`;
      })
      .join('');
    const shownFrom = res.total === 0 ? 0 : offset + 1;
    const shownTo = offset + res.artifacts.length;
    root.innerHTML = `
      <h2>Artifacts</h2>
      <div class="toolbar">
        <select id="kindFilter">${kindOptions}</select>
        <input type="text" id="pathPrefix" placeholder="path prefix filter, e.g. /home/you/src" value="${esc(pathPrefix)}" size="34" />
      </div>
      ${res.artifacts.length === 0 ? emptyState('no artifacts') : `
      <table>
        <thead><tr><th>kind</th><th>path / uri</th><th>bytes</th><th>created</th><th>session</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="pager">
        <button class="ghost" id="prev" ${offset === 0 ? 'disabled' : ''}>← prev</button>
        <span>${shownFrom}–${shownTo} of ${res.total}</span>
        <button class="ghost" id="next" ${shownTo >= res.total ? 'disabled' : ''}>next →</button>
      </div>`}
    `;
    const apply = (newOffset: number) => {
      const params = new URLSearchParams();
      const k = (root.querySelector('#kindFilter') as HTMLSelectElement).value;
      const p = (root.querySelector('#pathPrefix') as HTMLInputElement).value.trim();
      if (k) params.set('kind', k);
      if (p) params.set('pathPrefix', p);
      if (newOffset > 0) params.set('offset', String(newOffset));
      location.hash = `#/artifacts${params.size ? `?${params}` : ''}`;
    };
    root.querySelector('#kindFilter')?.addEventListener('change', () => apply(0));
    root.querySelector('#pathPrefix')?.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') apply(0);
    });
    root.querySelector('#prev')?.addEventListener('click', () => apply(Math.max(0, offset - PAGE)));
    root.querySelector('#next')?.addEventListener('click', () => apply(offset + PAGE));
  } catch (err) {
    errorBanner(root, err);
  }
}
