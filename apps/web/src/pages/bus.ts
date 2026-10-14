import { api } from '../api';
import { emptyState, errorBanner, esc, fmtTime, hueFor, loading } from '../util';

const POLL_MS = 5000;

export async function renderBus(root: HTMLElement, query: URLSearchParams): Promise<() => void> {
  loading(root);
  let timer: ReturnType<typeof setInterval> | null = null;
  let activeChannel = query.get('channel') ?? '';
  let cursor = 0;

  const stopPolling = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
  const onVisibility = () => {
    if (document.hidden) stopPolling();
    else {
      void loadMessages(true);
      startPolling();
    }
  };
  const startPolling = () => {
    stopPolling();
    if (!document.hidden) timer = setInterval(() => void loadMessages(true), POLL_MS);
  };

  async function loadMessages(incremental: boolean): Promise<void> {
    if (!activeChannel) return;
    try {
      const res = await api.busRead(activeChannel, incremental ? cursor : 0);
      if (!incremental) {
        root.querySelector('#busMessages')!.innerHTML = '';
        cursor = 0;
      }
      if (res.messages.length > 0) {
        const html = res.messages
          .map((m) => {
            const hue = hueFor(m.sender);
            const refs = m.refs && m.refs.length > 0 ? `<div class="refs">refs: ${esc(m.refs.join(', '))}</div>` : '';
            return `<div class="bus-msg">
              <span class="sender" style="color: hsl(${hue} 70% 70%)">${esc(m.sender)}</span>
              <span class="mono dim small"> #${m.seq} · ${esc(fmtTime(m.createdAt))}</span>
              <div class="msg-body">${esc(m.content)}</div>
              ${refs}
            </div>`;
          })
          .join('');
        root.querySelector('#busMessages')?.insertAdjacentHTML('beforeend', html);
      }
      cursor = Math.max(cursor, res.latestSeq);
    } catch {
      // transient poll failure: keep the pane as-is, retry next tick
    }
  }

  async function loadChannels(): Promise<void> {
    const res = await api.busChannels();
    const list = root.querySelector('#channelList')!;
    if (res.channels.length === 0) {
      list.innerHTML = emptyState('no channels yet — post below to create one');
      return;
    }
    list.innerHTML = res.channels
      .map(
        (ch) => `<a href="#/bus?channel=${encodeURIComponent(ch.channel)}" class="${ch.channel === activeChannel ? 'active' : ''}">
          <span class="mono">#${esc(ch.channel)}</span>
          <div class="dim small">${ch.count} msgs · ${esc(fmtTime(ch.lastActivity))} · ${esc(ch.senders.join(', '))}</div>
        </a>`,
      )
      .join('');
  }

  try {
    root.innerHTML = `
      <h2>Bus</h2>
      <div class="bus-layout">
        <div class="bus-channels"><div id="channelList"></div></div>
        <div class="bus-main">
          <div id="busMessages">${activeChannel ? '' : emptyState('select a channel on the left')}</div>
          <div class="bus-post">
            <div class="row">
              <input type="text" id="postChannel" placeholder="channel" value="${esc(activeChannel)}" />
              <input type="text" id="postSender" placeholder="your sender name" value="${esc(localStorage.getItem('omc-bus-sender') ?? '')}" />
            </div>
            <textarea id="postContent" placeholder="message…"></textarea>
            <div class="row"><button id="postBtn">post</button><span class="dim small" id="postStatus"></span></div>
          </div>
        </div>
      </div>`;
    await loadChannels();
    if (activeChannel) await loadMessages(false);
    startPolling();
    document.addEventListener('visibilitychange', onVisibility);

    root.querySelector('#postBtn')?.addEventListener('click', async () => {
      const channel = (root.querySelector('#postChannel') as HTMLInputElement).value.trim();
      const sender = (root.querySelector('#postSender') as HTMLInputElement).value.trim();
      const content = (root.querySelector('#postContent') as HTMLTextAreaElement).value.trim();
      const status = root.querySelector('#postStatus')!;
      if (!channel || !sender || !content) {
        status.textContent = 'channel, sender and content are required';
        return;
      }
      try {
        await api.busPost({ channel, sender, content, clientMsgId: crypto.randomUUID() });
        localStorage.setItem('omc-bus-sender', sender);
        (root.querySelector('#postContent') as HTMLTextAreaElement).value = '';
        status.textContent = 'posted';
        if (channel !== activeChannel) {
          activeChannel = channel;
          cursor = 0;
          await loadChannels();
          await loadMessages(false);
        } else {
          await loadMessages(true);
          await loadChannels();
        }
      } catch (err) {
        status.textContent = err instanceof Error ? err.message : String(err);
      }
    });
  } catch (err) {
    errorBanner(root, err);
  }

  return () => {
    stopPolling();
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
