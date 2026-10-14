import { api } from '../api';
import { emptyState, errorBanner, esc, fmtTime, loading, trunc } from '../util';

const PAGE = 50;

export async function renderSessions(root: HTMLElement, query: URLSearchParams): Promise<void> {
  loading(root);
  const offset = Math.max(0, Number(query.get('offset') ?? 0) || 0);
  const selectedSource = query.get('source') ?? '';
  try {
    const [ov, res] = await Promise.all([
      api.overview(),
      api.sessions(selectedSource, PAGE, offset),
    ]);
    const options = [
      `<option value="">all sources</option>`,
      ...ov.sources.map(
        (s) =>
          `<option value="${esc(s.source)}"${s.source === selectedSource ? ' selected' : ''}>${esc(s.source)} (${s.sessions})</option>`,
      ),
    ].join('');
    const rows = res.sessions
      .map(
        (s) => `<tr class="clickable" data-id="${s.id}">
          <td class="mono dim">${esc(fmtTime(s.startedAt))}</td>
          <td><span class="badge">${esc(s.source)}</span></td>
          <td>${esc(trunc(s.title ?? s.cwd ?? '(untitled)', 80))}</td>
          <td class="mono">${s.messageCount}</td>
        </tr>`,
      )
      .join('');
    const shownFrom = res.total === 0 ? 0 : offset + 1;
    const shownTo = offset + res.sessions.length;
    root.innerHTML = `
      <h2>Sessions</h2>
      <div class="toolbar"><select id="sourceFilter">${options}</select></div>
      ${res.sessions.length === 0 ? emptyState('no sessions') : `
      <table>
        <thead><tr><th>started</th><th>source</th><th>title / cwd</th><th>msgs</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="pager">
        <button class="ghost" id="prev" ${offset === 0 ? 'disabled' : ''}>← prev</button>
        <span>${shownFrom}–${shownTo} of ${res.total}</span>
        <button class="ghost" id="next" ${shownTo >= res.total ? 'disabled' : ''}>next →</button>
      </div>`}
    `;
    root.querySelector('#sourceFilter')?.addEventListener('change', (e) => {
      const v = (e.target as HTMLSelectElement).value;
      location.hash = `#/sessions${v ? `?source=${encodeURIComponent(v)}` : ''}`;
    });
    root.querySelector('#prev')?.addEventListener('click', () => {
      location.hash = `#/sessions?offset=${Math.max(0, offset - PAGE)}${selectedSource ? `&source=${encodeURIComponent(selectedSource)}` : ''}`;
    });
    root.querySelector('#next')?.addEventListener('click', () => {
      location.hash = `#/sessions?offset=${offset + PAGE}${selectedSource ? `&source=${encodeURIComponent(selectedSource)}` : ''}`;
    });
    root.querySelectorAll('tr.clickable').forEach((tr) => {
      tr.addEventListener('click', () => {
        location.hash = `#/sessions/${(tr as HTMLElement).dataset.id}`;
      });
    });
  } catch (err) {
    errorBanner(root, err);
  }
}
