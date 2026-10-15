import { api } from '../api';
import type { Page } from '../page';
import { emptyState, esc, fmtBytes, fmtTime, sourceColor } from '../util';

type DoctorData = Awaited<ReturnType<typeof api.doctor>>;

function uptimeHuman(sec: number | undefined): string {
  if (sec === undefined) return '-';
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)} 小时`;
  return `${(sec / 86400).toFixed(1)} 天`;
}

export const page: Page<Record<string, never>> = {
  key: () => 'status',
  load: () => api.doctor(),
  view(root, raw) {
    const d = raw as DoctorData;
    const daemonCard = d.daemon
      ? `<div class="card"><div class="num" style="color: var(--role-assistant)">在线</div>
         <div class="label">v${esc(d.daemon.version ?? '?')} · 已运行 ${uptimeHuman(d.daemon.uptimeSec)} · 127.0.0.1:${d.port}</div></div>`
      : `<div class="card"><div class="num" style="color: var(--role-tool)">未运行</div>
         <div class="label">127.0.0.1:${d.port} 无响应 — 运行 omc watch 或 omc ui</div></div>`;
    const sourceCards = d.sources
      .map((s) => {
        const sync = d.sync.find((x) => x.source === s.source);
        const syncLine = sync
          ? `最近同步 ${sync.lastMtime ? fmtTime(sync.lastMtime) : '-'}（${sync.ageMinutes ?? '?'} 分钟前）· 跟踪 ${sync.files} 个文件`
          : '';
        return `<div class="card">
          <div class="label"><span class="src-dot" style="background:${sourceColor(s.source)}"></span>${esc(s.source)}</div>
          <div class="num">${s.sessions}</div>
          <div class="label">${s.messages} 条消息 · ${s.artifacts} 个文件${syncLine ? `<br />${esc(syncLine)}` : ''}</div>
        </div>`;
      })
      .join('');
    const webRow =
      d.webSources.length > 0
        ? `<div class="card"><div class="label">网页捕获</div><div class="num" style="font-size:15px">${d.webSources.map(esc).join(' · ')}</div><div class="label">最近事件 ${esc(fmtTime(d.latest))}</div></div>`
        : `<div class="card"><div class="label">网页捕获</div><div class="num" style="font-size:15px">未捕获</div><div class="label"><a href="https://github.com/ohmycontext/ohmycontext/blob/main/docs/USER_GUIDE.md" target="_blank" rel="noopener">去装浏览器扩展</a></div></div>`;
    const hints =
      d.hints.length === 0
        ? ''
        : `<div class="eyebrow" style="margin-top:18px">提示</div>` +
          d.hints.map((h) => `<div class="hint-callout">${esc(h)}</div>`).join('');
    root.innerHTML = `
      <h2>状态</h2>
      <div class="eyebrow">服务</div>
      <div class="cards">${daemonCard}
        <div class="card"><div class="num">${fmtBytes(d.db.bytes)}</div><div class="label mono">${esc(d.db.path)}</div></div>
        <div class="card"><div class="num">${d.totals.sessions}</div><div class="label">会话 · ${d.totals.messages} 条消息 · ${d.totals.artifacts} 个文件</div></div>
      </div>
      <div class="eyebrow">来源</div>
      <div class="cards">${sourceCards || '<div class="empty">暂无数据</div>'}</div>
      <div class="eyebrow">网页捕获</div>
      <div class="cards">${webRow}</div>
      ${hints}
    `;
  },
};
