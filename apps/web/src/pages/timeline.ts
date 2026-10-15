import { api, type Overview, type RecentSession } from '../api';
import type { Page } from '../page';
import { dayBucket, dayLabel, emptyState, esc, fmtBytes, hueFor, relTime, trunc } from '../util';

interface TimelineData {
  ov: Overview;
  sessions: RecentSession[];
  total: number;
}

function sourceBadge(source: string): string {
  return `<span class="badge" style="color: hsl(${hueFor(source)} 75% 72%); border-color: hsl(${hueFor(source)} 45% 40%)">${esc(source)}</span>`;
}

export const page: Page<Record<string, never>> = {
  key: () => 'timeline',
  load: async () => {
    const [ov, act] = await Promise.all([api.overview(), api.activity(43200, 100)]);
    return { ov, sessions: act.sessions, total: act.total } satisfies TimelineData;
  },
  view(root, raw) {
    const { ov, sessions, total } = raw as TimelineData;
    const strip = `<div class="stat-strip mono">
      ${ov.totals.sessions} 个会话 · ${ov.totals.messages} 条消息 · ${ov.totals.artifacts} 个文件 · ${fmtBytes(ov.dbBytes)}
    </div>`;
    if (sessions.length === 0) {
      root.innerHTML = `${strip}<h2>动态</h2>${emptyState('最近 30 天没有活动')}`;
      return;
    }
    let lastBucket = '';
    const cards = sessions
      .map((s) => {
        const bucket = dayBucket(s.lastActivity);
        const header =
          bucket !== lastBucket
            ? `<div class="day-header">${bucket}${bucket === '更早' ? '' : ` · ${dayLabel(s.lastActivity)}`}</div>`
            : '';
        lastBucket = bucket;
        const label = trunc(s.title ?? s.cwd ?? s.id.slice(0, 8), 60);
        const preview = s.lastMessagePreview ? trunc(s.lastMessagePreview.replace(/\s+/g, ' '), 150) : '';
        const dateNote = bucket === '更早' ? `<span class="mono dim">${esc(dayLabel(s.lastActivity))}</span> ` : '';
        return `${header}<a class="tl-card" href="#/sessions/${s.id}">
          <div class="tl-top">
            <span class="tl-time mono">${esc(relTime(s.lastActivity))}</span>
            ${dateNote}${sourceBadge(s.source)}
            <span class="tl-title">${esc(label)}</span>
            <span class="dim small">${s.messageCount} 条</span>
          </div>
          ${preview ? `<div class="tl-preview dim">${esc(preview)}</div>` : ''}
        </a>`;
      })
      .join('');
    root.innerHTML = `
      ${strip}
      <h2>动态 <span class="dim small">最近 30 天 · ${total} 个活跃会话</span></h2>
      ${cards}
      ${total > sessions.length ? `<p class="dim small">只显示最近 ${sessions.length} 个</p>` : ''}`;
  },
};
