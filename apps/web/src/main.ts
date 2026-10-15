import './style.css';
import { esc } from './util';
import { fetchCached, getCached, prefetch } from './cache';
import type { Page } from './page';
import { page as timelinePage } from './pages/timeline';
import { page as searchPage } from './pages/search';
import { page as chatsPage } from './pages/chats';
import { page as filesPage } from './pages/files';
import { page as busPage } from './pages/bus';
import { page as sessionDetailPage } from './pages/sessionDetail';

const NAV = [
  { path: '#/', zh: '动态', en: 'Timeline' },
  { path: '#/search', zh: '搜索', en: 'Search' },
  { path: '#/chats', zh: '会话', en: 'Chats' },
  { path: '#/files', zh: '文件', en: 'Files' },
  { path: '#/bus', zh: '接力', en: 'Relay' },
];

const appEl = document.getElementById('app')!;
appEl.innerHTML = `
  <div id="topbar"></div>
  <div class="layout">
    <nav class="sidebar">
      <div class="brand">ohmycontext</div>
      ${NAV.map((r) => `<a href="${r.path}" data-route="${r.path}"><span class="nav-zh">${r.zh}</span><span class="nav-en">${r.en}</span></a>`).join('')}
      <div class="sidebar-foot">local-first · your data stays here<span id="ver"></span></div>
    </nav>
    <main id="content" class="content"></main>
  </div>`;

const content = document.getElementById('content')!;
const topbar = document.getElementById('topbar')!;

interface Resolved<P = unknown> {
  page: Page<P>;
  params: P;
}

function resolve(hash: string): Resolved | { redirect: string } {
  const [pathPart = '#/', queryPart = ''] = hash.split('?');
  const query = new URLSearchParams(queryPart);
  if (pathPart === '#/sessions') return { redirect: '#/chats' };
  if (pathPart === '#/artifacts') return { redirect: '#/files' };
  const sessionMatch = /^#\/sessions\/([0-9a-f]+)$/i.exec(pathPart);
  if (sessionMatch?.[1]) {
    return { page: sessionDetailPage as Page<unknown>, params: { id: sessionMatch[1] } };
  }
  switch (pathPart) {
    case '#/search':
      return { page: searchPage as Page<unknown>, params: { q: query.get('q') ?? '', source: query.get('source') ?? '' } };
    case '#/chats':
      return {
        page: chatsPage as Page<unknown>,
        params: { flat: query.get('flat') === '1', offset: Math.max(0, Number(query.get('offset') ?? 0) || 0) },
      };
    case '#/files':
      return {
        page: filesPage as Page<unknown>,
        params: {
          kind: query.get('kind') ?? '',
          pathPrefix: query.get('pathPrefix') ?? '',
          offset: Math.max(0, Number(query.get('offset') ?? 0) || 0),
        },
      };
    case '#/bus':
      return { page: busPage as Page<unknown>, params: { channel: query.get('channel') ?? '' } };
    default:
      return { page: timelinePage as Page<unknown>, params: {} };
  }
}

let viewCleanup: (() => void) | null = null;
let renderSeq = 0;

function topbarOn(): void {
  topbar.classList.add('on');
}
function topbarOff(): void {
  topbar.classList.remove('on');
}

async function render(): Promise<void> {
  const route = resolve(location.hash || '#/');
  if ('redirect' in route) {
    location.replace(route.redirect);
    return;
  }
  const { page, params } = route;
  const seq = ++renderSeq;
  if (viewCleanup) {
    viewCleanup();
    viewCleanup = null;
  }
  const key = page.key(params);
  const same = page.same ?? ((a, b) => JSON.stringify(a) === JSON.stringify(b));
  const cached = getCached(key);

  if (cached !== undefined) {
    // warm paint: instant render from cache, then silent revalidation
    viewCleanup = page.view(content, cached, params) ?? null;
  } else {
    content.innerHTML = '<div class="loading">加载中…</div>';
  }

  topbarOn();
  try {
    const fresh = await fetchCached(key, () => page.load(params));
    topbarOff();
    if (seq !== renderSeq) return; // navigated away meanwhile
    if (cached === undefined || !same(cached, fresh)) {
      if (viewCleanup) viewCleanup();
      viewCleanup = page.view(content, fresh, params) ?? null;
    }
  } catch (err) {
    topbarOff();
    if (cached === undefined) {
      const msg = err instanceof Error ? err.message : String(err);
      content.innerHTML = `<div class="error-banner">连不上本地服务（${esc(msg)}）。<code>omc watch</code> 在运行吗？</div>`;
    }
    // warm cache stays on screen during a failed revalidate
  }
}

// prefetch on hover/focus intent
for (const a of document.querySelectorAll('.sidebar a')) {
  const warm = () => {
    const r = resolve(a.getAttribute('data-route')!);
    if (!('redirect' in r)) prefetch(r.page.key(r.params), () => r.page.load(r.params));
  };
  a.addEventListener('pointerenter', warm);
  a.addEventListener('pointerdown', warm);
}

window.addEventListener('hashchange', () => void render());
void render();

// idle prefetch of all main routes right after first paint
setTimeout(() => {
  const idle = window.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 200));
  for (const n of NAV) {
    idle(() => {
      const r = resolve(n.path);
      if (!('redirect' in r)) prefetch(r.page.key(r.params), () => r.page.load(r.params));
    });
  }
}, 1200);

// sidebar version footer
fetch('/api/overview')
  .then((r) => (r.ok ? r.json() : null))
  .then((ov: { version?: string } | null) => {
    if (ov?.version) document.getElementById('ver')!.textContent = ` · v${ov.version}`;
  })
  .catch(() => {});
