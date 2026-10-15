# AGENTS.md — operating contract for AI agents

> **中文快速上手**：先跑 `node apps/cli/dist/index.js doctor --json` 自检；daemon 没起就 `nohup node apps/cli/dist/index.js watch >/dev/null 2>&1 &` 起后台。所有读命令加 `--json`；只能写 bus（`bus post`）和 `ingest`；**绝不**直接改 `~/.ohmycontext` 下的任何文件；数据是用户隐私，只读本地用途，禁止外发。

## What this is

ohmycontext is a local-first store that captures **all** of the user's AI
conversations (CLI agents, web chats) and AI-produced files into one SQLite
database with full-text search. It normalizes everything into an open JSONL
event format. It also provides a local message bus so different AI agents can
leave each other notes.

Everything is on this machine, loopback only. Treat all content as the user's
private data: read for the user's benefit, never exfiltrate, never upload.

## First move: self-check

```sh
node apps/cli/dist/index.js doctor --json
```

`doctor` reports daemon reachability, db path/size, per-source counts, sync
freshness, web-capture status, and actionable hints. It exits **1** when the
daemon is down (0 otherwise) — if down and the user wants live capture:

```sh
nohup node apps/cli/dist/index.js watch >/dev/null 2>&1 &
```

(or tell the user to run `omc ui`). If the `omc` binary is on PATH you can use
`omc` instead of `node apps/cli/dist/index.js`; this document uses the latter
because it always works.

## Rules

1. Always pass `--json` and parse it. Shapes are stable (see below).
2. **Read-only**, except: `bus post` and `ingest`. Nothing else writes.
3. NEVER create, modify, or delete anything under `~/.ohmycontext` directly —
   go through the CLI (or the daemon's HTTP API) only.
4. Don't export bulk data anywhere off this machine. Localhost only.
5. Prefer small, targeted queries (`search`, `recent`, `get`) over dumps.

## Cookbook

All commands below are `node apps/cli/dist/index.js <cmd>` (add `--json`).

### Orient

```sh
recent --minutes 1440 --limit 20      # what happened lately (per-session one-liners)
search "partition key" --limit 10     # FTS over every captured conversation
sessions --source codex --limit 10    # session list (ids shown as 8-char prefixes)
```

`recent` → `{total, returned, sessions: [{id, source, title?, cwd?, lastActivity, lastMessageRole, lastMessagePreview, messageCount}]}` (messageCount is in-window).

`search` → `[{id, sessionId, role, content, contentType, createdAt, source, cwd, title, snippet}]`

`sessions` → `[{id, source, externalId, title?, cwd?, startedAt, endedAt?, model?, messageCount, firstUserPreview}]`

### Read a conversation

```sh
get 1df7c376 --format json            # full session + chronological messages
get 1df7c376 --format md              # markdown rendering (human-readable)
get 1df7c376 --limit 200 --offset 200 --format json   # paginate
```

Accepts an unambiguous **id prefix ≥6 chars** (the prefixes other commands
print). Errors: exit 1 with `no session matches` / `ambiguous prefix …` /
`prefix too short`. JSON shape: `{session, total, returned, messages: [{id, role, contentType, content, createdAt, model?, tokenUsage?, parentId?}], artifacts: [...]}`.

### Relay between two agents (bus)

Agent A (e.g. Codex, finishing a task):

```sh
bus post review "task done: dark-theme toggle, diff at refs" \
  --sender codex --refs /repo/style.css --client-msg-id codex-task-42 --json
# → {"seq":1,"id":"…","duplicate":false}
```

Agent B (Claude Code, reviewing) — block until it arrives:

```sh
bus read --channel review --after-seq 0 --wait 300 --json
# resolves with the message + {"latestSeq":1,"timedOut":false}
```

B replies, then A waits again with its remembered cursor:

```sh
bus post review "LGTM, ship it" --sender claude-code
bus read --channel review --after-seq 1 --wait 300 --json   # back at A
```

Bus rules of etiquette: keep one **stable sender name** per agent; remember
`latestSeq` as your cursor and pass it back as `--after-seq`; channels are
free-form conventions (`review`, `tasks`, a project name are good starters).
Reposting with the same `--client-msg-id` is a safe idempotent retry
(`duplicate:true`, no new row).

`bus read` → `{messages: [{seq, id, channel, sender, content, refs?, createdAt}], latestSeq, truncated, timedOut?}`
`bus channels` → `{channels: [{channel, count, lastActivity, senders[]}]}`

Bus traffic is mirrored into the store (source `omc-bus`, one `#<channel>`
session per channel), so it is searchable/exportable like everything else.

### Diagnostics

```sh
doctor          # ✓/✗ human lines + hints; exit 1 if daemon down
doctor --json   # structured report (identical to GET /api/doctor)
stats           # totals, per-source counts, db size, time range
stats --json    # {version, dbPath, dbBytes, totals, sources, earliest, latest}
service status  # systemd unit + daemon reachability (install/uninstall exist;
                # the unit auto-starts the daemon at login on Linux)
```

## MCP alternative

Everything here also exists as MCP tools for agents that are MCP clients:
`search_context`, `list_sessions`, `get_session`, `recent_activity`,
`list_artifacts`, `context_stats`, `bus_post`, `bus_read`, `bus_wait`,
`bus_channels`. Registration snippets are in the README (`claude mcp add omc …`
/ Codex `[mcp_servers.omc]`). Use whichever transport is available; the data
is the same store.

## Reference: `--json` shapes

| Command | Shape |
| ------- | ----- |
| `search` | array of hit objects (see above) |
| `sessions` | array of session objects |
| `recent` | `{total, returned, sessions[]}` |
| `get --format json` | `{session, total, returned, messages[], artifacts[]}` |
| `stats` | `{version, dbPath, dbBytes, totals, sources[], earliest, latest}` |
| `bus post` | `{seq, id, duplicate}` |
| `bus read` | `{messages[], latestSeq, truncated, timedOut?}` |
| `bus channels` | `{channels[]}` |
| `doctor` | `{daemon, port, db, totals, earliest, latest, sources[], webSources[], sync[], hints[]}` |
