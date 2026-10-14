import { api } from '../api';
import { emptyState, errorBanner, esc, fmtBytes, fmtTime, loading, trunc } from '../util';

export async function renderOverview(root: HTMLElement): Promise<void> {
  loading(root);
  try {
    const [ov, act] = await Promise.all([api.overview(), api.activity(24 * 60, 15)]);
    const cards = [
      { num: ov.totals.sessions, label: 'sessions' },
      { num: ov.totals.messages, label: 'messages' },
      { num: ov.totals.artifacts, label: 'artifacts' },
      { num: ov.totals.events, label: 'events' },
      { num: fmtBytes(ov.dbBytes), label: 'db size' },
    ];
    const perSource = ov.sources
      .map(
        (s) =>
          `<div class="card"><div class="num">${s.sessions}</div><div class="label">${esc(s.source)} · ${s.messages} msgs · ${s.artifacts} artifacts</div></div>`,
      )
      .join('');
    const activity =
      act.sessions.length === 0
        ? emptyState('no activity in the last 24h')
        : act.sessions
            .map((s) => {
              const label = trunc(s.title ?? s.cwd ?? s.id.slice(0, 8), 70);
              const preview = s.lastMessagePreview ? trunc(s.lastMessagePreview.replace(/\s+/g, ' '), 110) : '';
              return `<a class="activity-row" href="#/sessions/${s.id}">
                <span class="mono dim">${esc(fmtTime(s.lastActivity))}</span>
                <span class="badge">${esc(s.source)}</span>
                <span>${esc(label)}</span>
                <span class="dim small">${s.messageCount} msgs · last ${esc(s.lastMessageRole ?? '?')}: ${esc(preview)}</span>
              </a>`;
            })
            .join('');
    root.innerHTML = `
      <h2>Overview</h2>
      <div class="cards">${cards.map((c) => `<div class="card"><div class="num">${c.num}</div><div class="label">${c.label}</div></div>`).join('')}</div>
      <div class="cards">${perSource}</div>
      <p class="dim small">range: <span class="mono">${esc(fmtTime(ov.earliest))}</span> → <span class="mono">${esc(fmtTime(ov.latest))}</span></p>
      <h2>Last 24h</h2>
      <div>${activity}</div>`;
  } catch (err) {
    errorBanner(root, err);
  }
}
