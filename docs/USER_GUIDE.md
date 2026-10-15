# ohmycontext 用户手册

![动态时间线](images/timeline.png)

## 这是什么

- 它把你和各家 AI（Claude Code、Codex、ChatGPT、DeepSeek、Kimi…）的对话**全部记录**在本地一个 SQLite 数据库里，全文可搜索。
- 它把不同工具私有、互不相通的日志**统一**成一种开放的 JSONL 事件格式（见 `docs/schema.md`）。
- 它让接入 MCP 的 AI 能**看见彼此**的工作：搜索彼此的历史、在「接力」频道里互相留言。

所有数据都在你自己的机器上，不上传、不联网（唯一的网络出口是本机 127.0.0.1）。

## 安装

要求：Node.js ≥ 20、pnpm。

```sh
git clone <仓库地址> && cd ohmycontext
pnpm install
pnpm build
```

## 快速开始

```sh
omc ui        # 扫描日志 → 启动本地服务 → 自动打开浏览器
```

没把 `omc` 放进 PATH 的话，用 `node apps/cli/dist/index.js ui`（或开发态 `pnpm ui`）。

打开后你会看到：

| 页面 | 看什么 |
| ---- | ------ |
| 动态 Timeline | 最近 30 天你在各家 AI 上干了什么（按时间排，左侧彩色圆点是来源） |
| 搜索 Search | 所有对话的全文搜索，关键词高亮 |
| 会话 Chats | 按来源 → 项目目录分组的会话列表，点进去看完整对话 |
| 文件 Files | AI 写过/改过的文件（含自动归因到会话） |
| 接力 Relay | AI 之间互相留言的频道 |

![会话详情](images/session.png)

## 浏览器扩展（网页版 AI 捕获）

CLI 工具（Claude Code / Codex）的日志是自动扫描的；**网页版**（chatgpt.com 等）需要装扩展：

1. `pnpm install && pnpm build`（只需一次，产物在 `apps/extension/.output/chrome-mv3`）。
2. 浏览器打开 `chrome://extensions` → 右上角打开「开发者模式」→「加载已解压的扩展程序」→ 选择 `apps/extension/.output/chrome-mv3`。
3. 保持 `omc watch`（或 `omc ui`）在运行，然后正常使用网页版 AI 即可。

支持站点：

| 站点 | 来源名 | 说明 |
| ---- | ------ | ---- |
| chatgpt.com | `chatgpt-web` | 自动读取 Bearer 令牌，整段会话增量归一化（API 链路 2026-10 实测通过） |
| claude.ai | `claude-web` | Cookie 鉴权 |
| chat.deepseek.com | `deepseek-web` | 沿消息树重建当前分支；需保持登录（令牌会过期） |
| kimi.com / kimi.moonshot.cn | `kimi-web` | 2026-10 实测：apiv2 Connect-RPC（ListMessages/GetChat），fetch 和 XHR 都拦截 |

**诊断页（排障必备）**：点扩展图标 → 「Diagnostics」标签。每个站点会显示：钩子是否激活（hook active）、最近拦截到的 API 请求（路径打码）、成功捕获次数、最近一次投递成功时间、最近一次错误。某站点没数据时，先看这里，再把「copy diagnostics」复制出来的 JSON 发给维护者。

## 把上下文接给 AI（MCP）

Claude Code：

```sh
claude mcp add omc -- node /home/YOU/Github/ohmycontext/apps/cli/dist/index.js mcp
```

Codex（`~/.codex/config.toml`）：

```toml
[mcp_servers.omc]
command = "node"
args = ["/home/YOU/Github/ohmycontext/apps/cli/dist/index.js", "mcp"]
```

接入后 AI 能用这些工具：`search_context`、`list_sessions`、`get_session`、`recent_activity`、`list_artifacts`、`context_stats`，以及接力四个（`bus_post` / `bus_read` / `bus_wait` / `bus_channels`）。

ChatGPT 开发者模式 / Claude Desktop 需要公网 URL：用隧道把 `http://127.0.0.1:27182/mcp` 暴露出去。**注意：拿到隧道 URL 的人能读到你的全部对话记录**，请用带访问控制的命名隧道（如 Cloudflare Access），临时隧道用完即关。

## 给 Agent 用

如果你的 AI 有 shell 权限，不用配 MCP 也能操作 ohmycontext：`omc` CLI 就是完整的 agent API（`search` / `recent` / `get` / `bus` / `doctor` / `stats`，全部支持稳定的 `--json` 输出）。把仓库根目录的 [AGENTS.md](../AGENTS.md) 交给 agent 即可——里面有操作契约、JSON 结构和接力配方。

## 接力 Relay 怎么玩

场景：Codex 干完活，想叫 Claude Code 来 review。

1. Codex（已接入 MCP）：`bus_post` 到频道 `review`，内容写摘要，`refs` 带上 diff 文件路径。
2. Claude Code 正在 `bus_wait` 阻塞等待 `review`——立刻收到，看完后 `bus_post` 回复。
3. Codex 下一次 `bus_wait` 拿到结论。

非 MCP 环境也能用 HTTP：`POST /bus/post`、`GET /bus/read?channel=review&after_seq=0`。MCP 没有推送，想准实时就定时轮询 `bus_wait`（cron / 自动化任务）。

![接力](images/relay.png)

## FAQ

- **端口被占用**：`OMC_PORT=27200 omc ui`（或 `omc watch --port 27200`）。默认 27182。
- **数据在哪**：`~/.ohmycontext/omc.db`（WAL 模式，配套 `-wal`/`-shm` 文件）。用 `OMC_HOME=/别的目录` 换位置。
- **怎么彻底卸载**：停掉所有 `omc` 进程 → `rm -rf ~/.ohmycontext` → 删掉仓库目录 → 浏览器里移除扩展 → 用 `claude mcp remove omc` / 删 Codex 配置块解除 MCP 注册。不残留任何东西。
- **隐私与安全**：只监听 127.0.0.1；Host 头校验防 DNS 重绑定；浏览器来源只允许浏览器扩展和 UI 自身，其他网页一律 403；POST 只收 JSON/NDJSON。详见 README「Security policy」。
- **导出备份**：`omc export --format jsonl --out backup.jsonl`；恢复：`omc ingest backup.jsonl`（按 id 去重，可反复导入）。

## 故障排查

| 现象 | 原因 | 动作 |
| ---- | ---- | ---- |
| `omc ui` 打开后空白/报错条 | 服务没起来或端口不对 | 看终端日志；确认访问的是同一个端口 |
| 网页版 AI 没有捕获 | 钩子未激活 / 令牌失效 / 站点改版 | 扩展 → Diagnostics 页；没有请求记录=URL 匹配失效；有请求无捕获=鉴权问题（重新登录该站点） |
| 搜索没结果 | 还没扫描过日志 | 跑一次 `omc watch --once` |
| 旧库中文搜索不到 | 老索引不支持中文子串 | 升级到新版后首次打开会自动重建索引（约 12 秒，一次性） |
| MCP 客户端连不上 | 路径不对或没 build | `pnpm build` 后再注册；用 `node <abs路径> mcp` 手动跑一下看输出 |
| 接力没动静 | 对方 AI 没在等/频道名不一致 | 两边用同一个频道名；用 `bus_channels` 看频道列表 |
| 数据库太大 | 全量捕获本来就这么大 | 文件内容不进库，主要是消息文本；可用新 OMC_HOME 重开 |
