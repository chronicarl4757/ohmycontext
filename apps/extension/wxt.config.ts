import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'ohmycontext',
    description: 'Capture AI web chats (chatgpt.com, claude.ai) into your local ohmycontext store',
    permissions: ['storage', 'alarms'],
    host_permissions: [
      '*://chatgpt.com/*',
      '*://claude.ai/*',
      'http://127.0.0.1:27182/*',
      'http://localhost:27182/*',
    ],
  },
});
