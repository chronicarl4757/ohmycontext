import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'ohmycontext',
    description: 'Capture AI web chats (ChatGPT, Claude, DeepSeek, Kimi) into your local ohmycontext store',
    permissions: ['storage', 'alarms'],
    host_permissions: [
      '*://chatgpt.com/*',
      '*://claude.ai/*',
      '*://chat.deepseek.com/*',
      '*://kimi.com/*',
      '*://*.kimi.com/*',
      '*://kimi.moonshot.cn/*',
      '*://*.kimi.moonshot.cn/*',
      'http://127.0.0.1:27182/*',
      'http://localhost:27182/*',
    ],
  },
});
