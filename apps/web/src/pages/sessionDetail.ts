import { api, type ArtifactRow, type MessageRow, type SessionRow } from '../api';
import type { Page } from '../page';
import { renderMarkdown } from '../markdown';
import { emptyState, esc, fmtBytes, fmtTime } from '../util';

const PAGE = 200;
const COLLAPSE_CHARS = 2000;

interface DetailParams {
  id: string;
}

interface DetailData {
  session: SessionRow | null;
  messages: MessageRow[];
  total: number;
  artifacts: ArtifactRow[];
}

export const page: Page<DetailParams> = {
  key: (p) => `session:${p.id}`,
  load: (p) => api.session(p.id, PAGE, 0) as Promise<DetailData>,
  same: (a, b) => {
    const x = a as DetailData;
    const y = b as DetailData;
    return (
      x.total === y.total &&
      x.messages.length === y.messages.length &&
      x.messages[x.messages.length - 1]?.id === y.messages[y.messages.length - 1]?.id &&
      x.artifacts.length === y.artifacts.length
    );
  },
  view(root, raw, p) {
    const data = raw as DetailData;
    if (!data.session) {
      root.innerHTML = `<p><a href="#/chats">← 返回会话列表</a></p>${emptyState('会话不存在')}`;
      return;
    }
    const loaded: MessageRow[] = [...data.messages];

    function messageHtml(m: MessageRow, idx: number): string {
      const head = `<div class="msg-head">
        <span class="msg-role">${esc(m.role)}</span>
        <span class="mono">${esc(fmtTime(m.createdAt))}</span>
        ${m.model ? `<span class="badge">${esc(m.model)}</span>` : ''}
        ${m.contentType !== 'text' ? `<span class="badge">${esc(m.contentType)}</span>` : ''}
      </div>`;
      const overlong = m.content.length > COLLAPSE_CHARS;
      const markdown = m.contentType === 'text' && (m.role === 'user' || m.role === 'assistant');
      const shown = overlong ? `${m.content.slice(0, COLLAPSE_CHARS)}…` : m.content;
      const bodyHtml = markdown ? renderMarkdown(shown) : esc(shown);
      const body = `<div class="msg-body${markdown ? ' md' : ''}">${bodyHtml}</div>${overlong ? `<button class="ghost small show-more" data-idx="${idx}">展开全文</button>` : ''}`;
      const inner =
        m.contentType === 'text'
          ? body
          : `<details><summary>${esc(m.contentType)} — 点击展开</summary>${body}</details>`;
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
          if (m && body) {
            const markdown = m.contentType === 'text' && (m.role === 'user' || m.role === 'assistant');
            body.innerHTML = markdown ? renderMarkdown(m.content) : esc(m.content);
          }
          el.remove();
        });
      });
    }

    const s = data.session;
    const arts =
      data.artifacts.length === 0
        ? ''
        : `<h2>文件产物 (${data.artifacts.length})</h2>
           <table><thead><tr><th>类型</th><th>路径 / URI</th><th>大小</th><th>时间</th></tr></thead>
           <tbody>${data.artifacts
             .map(
               (a) => `<tr><td>${esc(a.kind)}</td><td class="mono">${esc(a.path ?? a.uri ?? a.id)}</td><td class="mono dim">${fmtBytes(a.bytes)}</td><td class="mono dim">${esc(fmtTime(a.createdAt))}</td></tr>`,
             )
             .join('')}</tbody></table>`;
    root.innerHTML = `
      <p><a href="#/chats">← 返回会话列表</a></p>
      <h2>${esc(s.title ?? s.cwd ?? s.id)}</h2>
      <p class="dim small">
        <span class="badge">${esc(s.source)}</span>
        <span class="mono">${esc(fmtTime(s.startedAt))}</span> → <span class="mono">${esc(fmtTime(s.endedAt))}</span>
        · ${data.total} 条消息${s.model ? ` · <span class="badge">${esc(s.model)}</span>` : ''}${s.cwd ? ` · <span class="mono">${esc(s.cwd)}</span>` : ''}
      </p>
      <div id="messages">${data.messages.map((m, i) => messageHtml(m, i)).join('')}</div>
      ${data.messages.length < data.total ? '<div class="pager"><button class="ghost" id="loadMore">加载更多</button></div>' : ''}
      ${arts}
    `;
    wireShowMore();
    root.querySelector('#loadMore')?.addEventListener('click', async (e) => {
      const btn = e.target as HTMLButtonElement;
      btn.disabled = true;
      const more = await api.session(p.id, PAGE, loaded.length);
      const startIdx = loaded.length;
      loaded.push(...more.messages);
      root
        .querySelector('#messages')!
        .insertAdjacentHTML('beforeend', more.messages.map((m, i) => messageHtml(m, startIdx + i)).join(''));
      wireShowMore();
      if (loaded.length >= more.total) btn.closest('.pager')?.remove();
      else btn.disabled = false;
    });
  },
};
