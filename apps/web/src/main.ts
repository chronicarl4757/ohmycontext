import './style.css';
import { esc } from './util';
import { renderOverview } from './pages/overview';
import { renderSessions } from './pages/sessions';
import { renderSessionDetail } from './pages/sessionDetail';
import { renderSearch } from './pages/search';
import { renderArtifacts } from './pages/artifacts';
import { renderBus } from './pages/bus';

const NAV = [
  { path: '#/', label: 'Overview' },
  { path: '#/sessions', label: 'Sessions' },
  { path: '#/search', label: 'Search' },
  { path: '#/artifacts', label: 'Artifacts' },
  { path: '#/bus', label: 'Bus' },
];

const appEl = document.getElementById('app')!;
appEl.innerHTML = `
  <div class="layout">
    <nav class="sidebar">
      <div class="brand">ohmycontext</div>
      ${NAV.map((r) => `<a href="${r.path}" data-route="${r.path}">${r.label}</a>`).join('')}
      <div class="sidebar-foot">local-first · your data stays here</div>
    </nav>
    <main id="content" class="content"></main>
  </div>`;

let cleanup: (() => void) | null = null;

async function render(): Promise<void> {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
  const hash = location.hash || '#/';
  const [pathPart = '#/', queryPart = ''] = hash.split('?');
  const query = new URLSearchParams(queryPart);
  const content = document.getElementById('content')!;

  for (const a of document.querySelectorAll('.sidebar a')) {
    const route = a.getAttribute('data-route')!;
    const active = route === '#/' ? pathPart === '#/' : pathPart.startsWith(route);
    a.classList.toggle('active', active);
  }

  try {
    const sessionMatch = /^#\/sessions\/([0-9a-f]+)$/i.exec(pathPart);
    if (sessionMatch?.[1]) {
      await renderSessionDetail(content, sessionMatch[1]);
    } else if (pathPart === '#/sessions') {
      await renderSessions(content, query);
    } else if (pathPart === '#/search') {
      await renderSearch(content, query);
    } else if (pathPart === '#/artifacts') {
      await renderArtifacts(content, query);
    } else if (pathPart === '#/bus') {
      cleanup = (await renderBus(content, query)) ?? null;
    } else {
      await renderOverview(content);
    }
  } catch (err) {
    content.innerHTML = `<div class="error-banner">unexpected error: ${esc(err instanceof Error ? err.message : String(err))}</div>`;
  }
}

window.addEventListener('hashchange', () => void render());
void render();
