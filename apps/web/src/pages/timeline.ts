import { api, type Overview, type RecentSession } from '../api';
import type { Page } from '../page';
import { dayBucket, dayLabel, emptyState, esc, fmtBytes, relTime, sourceColor, sourceBadge, trunc } from '../util';

interface TimelineData {
  ov: Overview;
  sessions: RecentSession[];
  total: number;
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
      .map((s, i) => {
        const bucket = dayBucket(s.lastActivity);
        const header =
          bucket !== lastBucket
            ? `<div class="day-header">${bucket}${bucket === '更早' ? '' : ` · ${dayLabel(s.lastActivity)}`}</div>`
            : '';
        lastBucket = bucket;
        const label = trunc(s.title ?? s.cwd ?? s.id.slice(0, 8), 60);
        const preview = s.lastMessagePreview ? trunc(s.lastMessagePreview.replace(/\s+/g, ' '), 150) : '';
        const delay = `${Math.min(i, 5) * 40}ms`;
        return `${header}<a class="tl-card" href="#/sessions/${s.id}" style="--i: ${delay}; --node: ${sourceColor(s.source)}">
          <div class="tl-top">
            <span class="tl-time mono">${esc(relTime(s.lastActivity))}</span>
            ${sourceBadge(s.source)}
            <span class="tl-title">${esc(label)}</span>
            <span class="dim small">${s.messageCount} 条</span>
          </div>
          ${preview ? `<div class="tl-preview dim">${esc(preview)}</div>` : ''}
        </a>`;
      })
      .join('');
    root.innerHTML = `
      ${strip}
      <h2>动态 <span class="small">最近 30 天 · ${total} 个活跃会话</span></h2>
      <div class="tl-stream">${cards}</div>
      ${total > sessions.length ? `<p class="dim small">只显示最近 ${sessions.length} 个</p>` : ''}`;
  },
};
