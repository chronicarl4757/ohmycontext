import { api, type ArtifactRow } from '../api';
import type { Page } from '../page';
import { emptyState, esc, fileIcon, fmtBytes, fmtTime, trunc } from '../util';

const PAGE = 50;

interface FilesParams {
  kind: string;
  pathPrefix: string;
  offset: number;
}

interface FilesData {
  artifacts: ArtifactRow[];
  total: number;
}

export const page: Page<FilesParams> = {
  key: (p) => `files:${p.kind}:${p.pathPrefix}:${p.offset}`,
  load: async (p) => api.artifacts(p.kind, p.pathPrefix, PAGE, p.offset) as Promise<FilesData>,
  view(root, raw, p) {
    const { artifacts, total } = raw as FilesData;
    const kindOptions = ['', 'file', 'image', 'url', 'other']
      .map((k) => `<option value="${k}"${k === p.kind ? ' selected' : ''}>${k || '全部类型'}</option>`)
      .join('');
    const rows = artifacts
      .map((a) => {
        const target = a.path ?? a.uri ?? a.id;
        const sess = a.sessionId ? `<a href="#/sessions/${a.sessionId}">会话</a>` : '<span class="dim">—</span>';
        return `<tr>
          <td>${fileIcon(a.path, a.kind)} ${esc(a.kind)}</td>
          <td class="mono">${esc(trunc(target, 100))}</td>
          <td class="mono dim">${fmtBytes(a.bytes)}</td>
          <td class="mono dim">${esc(fmtTime(a.createdAt))}</td>
          <td>${sess}</td>
        </tr>`;
      })
      .join('');
    const shownFrom = total === 0 ? 0 : p.offset + 1;
    const shownTo = p.offset + artifacts.length;
    root.innerHTML = `
      <h2>文件</h2>
      <div class="toolbar">
        <select id="kindFilter">${kindOptions}</select>
        <input type="text" id="pathPrefix" placeholder="路径前缀过滤，如 /home/you/src" value="${esc(p.pathPrefix)}" size="34" />
      </div>
      ${artifacts.length === 0 ? emptyState('还没有捕获到文件产物。') : `
      <table>
        <thead><tr><th>类型</th><th>路径 / URI</th><th>大小</th><th>时间</th><th>会话</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="pager">
        <button class="ghost" id="prev" ${p.offset === 0 ? 'disabled' : ''}>← 上一页</button>
        <span>${shownFrom}–${shownTo} / ${total}</span>
        <button class="ghost" id="next" ${shownTo >= total ? 'disabled' : ''}>下一页 →</button>
      </div>`}
    `;
    const apply = (newOffset: number) => {
      const params = new URLSearchParams();
      const k = (root.querySelector('#kindFilter') as HTMLSelectElement).value;
      const prefix = (root.querySelector('#pathPrefix') as HTMLInputElement).value.trim();
      if (k) params.set('kind', k);
      if (prefix) params.set('pathPrefix', prefix);
      if (newOffset > 0) params.set('offset', String(newOffset));
      location.hash = `#/files${params.size ? `?${params}` : ''}`;
    };
    root.querySelector('#kindFilter')?.addEventListener('change', () => apply(0));
    root.querySelector('#pathPrefix')?.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') apply(0);
    });
    root.querySelector('#prev')?.addEventListener('click', () => apply(Math.max(0, p.offset - PAGE)));
    root.querySelector('#next')?.addEventListener('click', () => apply(p.offset + PAGE));
  },
};
