import { api, type Overview, type SessionRow } from '../api';
import type { Page } from '../page';
import { emptyState, esc, fmtTime, hueFor, trunc } from '../util';

const FLAT_PAGE = 50;

interface ChatsParams {
  flat: boolean;
  offset: number;
}

interface ChatsData {
  ov: Overview;
  sessions: SessionRow[];
  total: number;
}

function rowHtml(s: SessionRow, showSource: boolean): string {
  const label = s.title ?? ((s.firstUserPreview ? trunc(s.firstUserPreview.replace(/\s+/g, ' '), 60) : '') || s.cwd || '(untitled)');
  return `<tr class="clickable" data-id="${s.id}">
    <td class="mono dim">${esc(fmtTime(s.startedAt))}</td>
    ${showSource ? `<td><span class="badge" style="color: hsl(${hueFor(s.source)} 75% 72%)">${esc(s.source)}</span></td>` : ''}
    <td>${esc(trunc(label, 80))}</td>
    <td class="mono">${s.messageCount}</td>
  </tr>`;
}

function groupedHtml(sessions: SessionRow[]): string {
  const bySource = new Map<string, SessionRow[]>();
  for (const s of sessions) {
    const list = bySource.get(s.source) ?? [];
    list.push(s);
    bySource.set(s.source, list);
  }
  const sections: string[] = [];
  for (const [source, list] of [...bySource.entries()].sort()) {
    const byCwd = new Map<string, SessionRow[]>();
    for (const s of list) {
      const cwd = s.cwd ?? '(no cwd)';
      const g = byCwd.get(cwd) ?? [];
      g.push(s);
      byCwd.set(cwd, g);
    }
    const groups = [...byCwd.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([cwd, group]) => {
        const inner = group
          .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
          .map((s) => rowHtml(s, false))
          .join('');
        return `<details class="cwd-group">
          <summary><span class="mono">${esc(cwd)}</span> <span class="dim small">${group.length} 个会话</span></summary>
          <table><thead><tr><th>时间</th><th>标题 / 首条消息</th><th>消息数</th></tr></thead><tbody>${inner}</tbody></table>
        </details>`;
      })
      .join('');
    sections.push(`<details class="source-group" open>
      <summary><span class="badge" style="color: hsl(${hueFor(source)} 75% 72%)">${esc(source)}</span> <span class="dim small">${list.length} 个会话</span></summary>
      ${groups}
    </details>`);
  }
  return sections.join('');
}

export const page: Page<ChatsParams> = {
  key: (p) => (p.flat ? `chats:flat:${p.offset}` : 'chats:grouped'),
  load: async (p) => {
    const [ov, res] = await Promise.all([
      api.overview(),
      p.flat ? api.sessions('', FLAT_PAGE, p.offset) : api.sessions('', 500, 0),
    ]);
    return { ov, sessions: res.sessions, total: res.total } satisfies ChatsData;
  },
  same: (a, b) => {
    const x = a as ChatsData;
    const y = b as ChatsData;
    return (
      x.total === y.total &&
      x.sessions.length === y.sessions.length &&
      x.sessions[0]?.id === y.sessions[0]?.id &&
      x.sessions[x.sessions.length - 1]?.id === y.sessions[y.sessions.length - 1]?.id
    );
  },
  view(root, raw, p) {
    const { sessions, total } = raw as ChatsData;
    let body: string;
    if (p.flat) {
      const shownFrom = total === 0 ? 0 : p.offset + 1;
      const shownTo = p.offset + sessions.length;
      body =
        sessions.length === 0
          ? emptyState('暂无会话')
          : `<table><thead><tr><th>时间</th><th>来源</th><th>标题 / 首条消息</th><th>消息数</th></tr></thead>
             <tbody>${sessions.map((s) => rowHtml(s, true)).join('')}</tbody></table>
             <div class="pager">
               <button class="ghost" id="prev" ${p.offset === 0 ? 'disabled' : ''}>← 上一页</button>
               <span>${shownFrom}–${shownTo} / ${total}</span>
               <button class="ghost" id="next" ${shownTo >= total ? 'disabled' : ''}>下一页 →</button>
             </div>`;
    } else {
      body = sessions.length === 0 ? emptyState('暂无会话') : groupedHtml(sessions);
      if (total > sessions.length) body += `<p class="dim small">分组视图显示最近 ${sessions.length} / ${total} 个会话</p>`;
    }
    root.innerHTML = `
      <h2>会话</h2>
      <div class="toolbar">
        <label class="small dim"><input type="checkbox" id="flatToggle" ${p.flat ? 'checked' : ''} /> 全部（平铺列表）</label>
      </div>
      ${body}`;
    root.querySelector('#flatToggle')?.addEventListener('change', (e) => {
      const flat = (e.target as HTMLInputElement).checked;
      location.hash = flat ? '#/chats?flat=1' : '#/chats';
    });
    root.querySelector('#prev')?.addEventListener('click', () => {
      location.hash = `#/chats?flat=1&offset=${Math.max(0, p.offset - FLAT_PAGE)}`;
    });
    root.querySelector('#next')?.addEventListener('click', () => {
      location.hash = `#/chats?flat=1&offset=${p.offset + FLAT_PAGE}`;
    });
    root.querySelectorAll('tr.clickable').forEach((tr) => {
      tr.addEventListener('click', () => {
        location.hash = `#/sessions/${(tr as HTMLElement).dataset.id}`;
      });
    });
  },
};
