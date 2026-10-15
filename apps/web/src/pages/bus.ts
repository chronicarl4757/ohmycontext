import { api, type BusChannel } from '../api';
import type { Page } from '../page';
import { emptyState, esc, fmtTime, hueFor } from '../util';

const POLL_MS = 5000;

interface BusParams {
  channel: string;
}

export const page: Page<BusParams> = {
  key: () => 'relay:channels',
  load: async () => api.busChannels(),
  view(root, raw, p) {
    let activeChannel = p.channel;
    let cursor = 0;
    let timer: ReturnType<typeof setInterval> | null = null;

    const stopPolling = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const startPolling = () => {
      stopPolling();
      if (!document.hidden) timer = setInterval(() => void loadMessages(true), POLL_MS);
    };
    const onVisibility = () => {
      if (document.hidden) stopPolling();
      else {
        void loadMessages(true);
        startPolling();
      }
    };

    async function loadMessages(incremental: boolean): Promise<void> {
      if (!activeChannel) return;
      try {
        const res = await api.busRead(activeChannel, incremental ? cursor : 0);
        const pane = root.querySelector('#busMessages');
        if (!pane) return;
        if (!incremental) {
          pane.innerHTML = '';
          cursor = 0;
        }
        if (res.messages.length > 0) {
          pane.insertAdjacentHTML(
            'beforeend',
            res.messages
              .map((m) => {
                const hue = hueFor(m.sender);
                const refs =
                  m.refs && m.refs.length > 0 ? `<div class="refs">refs: ${esc(m.refs.join(', '))}</div>` : '';
                return `<div class="bus-msg">
                  <span class="sender" style="color: hsl(${hue} 70% 70%)">${esc(m.sender)}</span>
                  <span class="mono dim small"> #${m.seq} · ${esc(fmtTime(m.createdAt))}</span>
                  <div class="msg-body">${esc(m.content)}</div>
                  ${refs}
                </div>`;
              })
              .join(''),
          );
        }
        cursor = Math.max(cursor, res.latestSeq);
      } catch {
        // transient poll failure: keep the pane, retry next tick
      }
    }

    async function renderChannels(channels: BusChannel[]): Promise<void> {
      const list = root.querySelector('#channelList');
      if (!list) return;
      list.innerHTML =
        channels.length === 0
          ? emptyState("还没有频道。让接入 MCP 的 AI 发第一条消息，例如让 Codex 调用 bus_post 到 'review'。")
          : channels
              .map(
                (ch) => `<a href="#/bus?channel=${encodeURIComponent(ch.channel)}" class="${ch.channel === activeChannel ? 'active' : ''}">
                  <span class="mono">#${esc(ch.channel)}</span>
                  <div class="dim small">${ch.count} 条 · ${esc(fmtTime(ch.lastActivity))} · ${esc(ch.senders.join(', '))}</div>
                </a>`,
              )
              .join('');
    }

    const channels = (raw as { channels: BusChannel[] }).channels;
    root.innerHTML = `
      <h2>接力</h2>
      <p class="dim small">AI 之间互相留言的频道 — 任何一个接入 MCP 的 AI 都能读写。</p>
      <div class="bus-layout">
        <div class="bus-channels"><div id="channelList"></div></div>
        <div class="bus-main">
          <div id="busMessages">${activeChannel ? '' : emptyState('在左侧选择一个频道')}</div>
          <div class="bus-post">
            <div class="row">
              <input type="text" id="postChannel" placeholder="频道" value="${esc(activeChannel)}" />
              <input type="text" id="postSender" placeholder="你的名字（如 me / claude-code）" value="${esc(localStorage.getItem('omc-bus-sender') ?? '')}" />
            </div>
            <textarea id="postContent" placeholder="消息…"></textarea>
            <div class="row"><button id="postBtn">发送</button><span class="dim small" id="postStatus"></span></div>
          </div>
        </div>
      </div>`;
    void renderChannels(channels);
    if (activeChannel) void loadMessages(false);
    startPolling();
    document.addEventListener('visibilitychange', onVisibility);

    root.querySelector('#postBtn')?.addEventListener('click', async () => {
      const channel = (root.querySelector('#postChannel') as HTMLInputElement).value.trim();
      const sender = (root.querySelector('#postSender') as HTMLInputElement).value.trim();
      const content = (root.querySelector('#postContent') as HTMLTextAreaElement).value.trim();
      const status = root.querySelector('#postStatus')!;
      if (!channel || !sender || !content) {
        status.textContent = '频道、名字、消息都要填';
        return;
      }
      try {
        await api.busPost({ channel, sender, content, clientMsgId: crypto.randomUUID() });
        localStorage.setItem('omc-bus-sender', sender);
        (root.querySelector('#postContent') as HTMLTextAreaElement).value = '';
        status.textContent = '已发送';
        if (channel !== activeChannel) {
          activeChannel = channel;
          cursor = 0;
          await loadMessages(false);
        } else {
          await loadMessages(true);
        }
        void renderChannels((await api.busChannels()).channels);
      } catch (err) {
        status.textContent = err instanceof Error ? err.message : String(err);
      }
    });

    // clicking a channel link swaps the pane in place without a full route render
    root.querySelector('#channelList')?.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest('a');
      if (!a) return;
      e.preventDefault();
      const url = new URL((a as HTMLAnchorElement).href);
      const m = /channel=([^&]+)/.exec(url.hash);
      activeChannel = decodeURIComponent(m?.[1] ?? '');
      history.replaceState(null, '', `#/bus?channel=${encodeURIComponent(activeChannel)}`);
      cursor = 0;
      (root.querySelector('#postChannel') as HTMLInputElement).value = activeChannel;
      root.querySelectorAll('#channelList a').forEach((el) => el.classList.remove('active'));
      a.classList.add('active');
      void loadMessages(false);
    });

    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  },
};
