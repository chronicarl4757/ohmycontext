import { api, type MessageRow } from '../api';
import { emptyState, errorBanner, esc, fmtBytes, fmtTime, loading } from '../util';

const PAGE = 200;
const COLLAPSE_CHARS = 2000;

export async function renderSessionDetail(root: HTMLElement, id: string): Promise<void> {
  loading(root);
  const loaded: MessageRow[] = [];

  function messageHtml(m: MessageRow, idx: number): string {
    const head = `<div class="msg-head">
      <span class="msg-role">${esc(m.role)}</span>
      <span class="mono">${esc(fmtTime(m.createdAt))}</span>
      ${m.model ? `<span class="badge">${esc(m.model)}</span>` : ''}
      ${m.contentType !== 'text' ? `<span class="badge">${esc(m.contentType)}</span>` : ''}
    </div>`;
    const overlong = m.content.length > COLLAPSE_CHARS;
    const shown = overlong ? `${m.content.slice(0, COLLAPSE_CHARS)}…` : m.content;
    const body = `<div class="msg-body">${esc(shown)}</div>${overlong ? `<button class="ghost small show-more" data-idx="${idx}">show more</button>` : ''}`;
    const inner =
      m.contentType === 'text'
        ? body
        : `<details><summary>${esc(m.contentType)} — click to expand</summary>${body}</details>`;
    return `<div class="msg ${esc(m.role)}">${head}${inner}</div>`;
  }

  function wireShowMore(): void {
    root.querySelectorAll('.show-more').forEach((btn) => {
      const el = btn as HTMLElement;
      if (el.dataset.wired) return;
      el.dataset.wired = '1';
      el.addEventListener('click', () => {
        const m = loaded[Number(el.dataset.idx)];
        const body = el.closest('.msg')?.querySelector('.msg-body');
        if (m && body) body.textContent = m.content;
        el.remove();
      });
    });
  }

  try {
    const res = await api.session(id, PAGE, 0);
    if (!res.session) {
      root.innerHTML = emptyState('session not found');
      return;
    }
    loaded.push(...res.messages);
    const s = res.session;
    const arts =
      res.artifacts.length === 0
        ? ''
        : `<h2>Artifacts (${res.artifacts.length})</h2>
           <table><thead><tr><th>kind</th><th>path / uri</th><th>bytes</th><th>created</th></tr></thead>
           <tbody>${res.artifacts
             .map(
               (a) => `<tr><td>${esc(a.kind)}</td><td class="mono">${esc(a.path ?? a.uri ?? a.id)}</td><td class="mono dim">${fmtBytes(a.bytes)}</td><td class="mono dim">${esc(fmtTime(a.createdAt))}</td></tr>`,
             )
             .join('')}</tbody></table>`;
    root.innerHTML = `
      <h2>${esc(s.title ?? s.cwd ?? s.id)}</h2>
      <p class="dim small">
        <span class="badge">${esc(s.source)}</span>
        <span class="mono">${esc(fmtTime(s.startedAt))}</span> → <span class="mono">${esc(fmtTime(s.endedAt))}</span>
        · ${res.total} messages${s.model ? ` · <span class="badge">${esc(s.model)}</span>` : ''}${s.cwd ? ` · <span class="mono">${esc(s.cwd)}</span>` : ''}
      </p>
      <div id="messages">${res.messages.map((m, i) => messageHtml(m, i)).join('')}</div>
      ${res.messages.length < res.total ? '<div class="pager"><button class="ghost" id="loadMore">load more</button></div>' : ''}
      ${arts}
    `;
    wireShowMore();
    root.querySelector('#loadMore')?.addEventListener('click', async (e) => {
      const btn = e.target as HTMLButtonElement;
      btn.disabled = true;
      const more = await api.session(id, PAGE, loaded.length);
      const startIdx = loaded.length;
      loaded.push(...more.messages);
      root
        .querySelector('#messages')!
        .insertAdjacentHTML('beforeend', more.messages.map((m, i) => messageHtml(m, startIdx + i)).join(''));
      wireShowMore();
      if (loaded.length >= more.total) btn.closest('.pager')?.remove();
      else btn.disabled = false;
    });
  } catch (err) {
    errorBanner(root, err);
  }
}
