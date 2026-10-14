# ohmycontext

Local-first **personal AI context layer**. ohmycontext automatically captures your
AI coding conversations from every tool you use, normalizes them into an open
JSONL event format, stores them in a local SQLite database with full-text search,
and lets you search and export everything. Your data never leaves your machine.

## Why

AI coding assistants (Claude Code, Codex, …) each keep their own conversation
logs in private, incompatible formats. Your hard-won context — decisions,
debugging trails, design discussions — is scattered and locked in. ohmycontext
unifies it into one open, queryable, portable store that *you* own.

- **Local-first**: plain SQLite at `~/.ohmycontext/omc.db`, no cloud, no account.
- **Open format**: every captured event is normalized into a documented,
  versioned JSONL interchange format (see [docs/schema.md](docs/schema.md))
  designed to become a community standard.
- **Incremental & idempotent**: byte-offset tailing of log files; re-imports and
  re-scans never create duplicates (events are deduplicated by stable ids).

## Install

Requirements: Node.js >= 20, pnpm.

```sh
git clone <repo-url> && cd ohmycontext
pnpm install
pnpm build
```

The CLI is `omc` (`apps/cli`). Run it from source with `pnpm dev <args>`, or after
`pnpm build` via `node apps/cli/dist/index.js` (or `pnpm link --global` the CLI).

## Quickstart

```sh
# one-shot scan of all known AI tool logs (~/.claude/projects, ~/.codex/sessions)
omc watch --once

# run the daemon: watches logs continuously + serves a local HTTP API
omc watch                 # http://127.0.0.1:27182 (OMC_PORT to override)

# full-text search across every captured conversation
omc search "that error" --source claude-code --limit 10

# list sessions
omc sessions --source codex

# database overview
omc stats

# export
omc export --format md --session <id> --out session.md   # markdown w/ frontmatter
omc export --format jsonl --out backup.jsonl             # the open event format
omc export --format json  --out dump.json                # {sessions,messages,artifacts}

# import open-format JSONL (round-trips with export; reads stdin if no files)
omc ingest backup.jsonl
cat backup.jsonl | omc ingest
```

`OMC_HOME` overrides the data directory (default `~/.ohmycontext`).

### HTTP API (daemon)

| Endpoint        | Description                                             |
| --------------- | ------------------------------------------------------- |
| `GET /health`   | `{ok, version, uptimeSec}`                              |
| `GET /stats`    | per-source counts, db size, event time range            |
| `POST /ingest`  | body = open-format JSONL; returns `{ingested, skipped}` |

`POST /ingest` is the entry point for future producers that can't be
file-tailed (browser extensions, IDE plugins, other agents).

## Repository layout

```
packages/core        @ohmycontext/core  — open zod schema + SQLite store (FTS5)
packages/connectors  @ohmycontext/connectors — log-format connectors (claude-code, codex)
packages/daemon      @ohmycontext/daemon — chokidar watcher + hono HTTP API + /mcp endpoint
packages/mcp         @ohmycontext/mcp   — MCP server (tools over the context store)
apps/cli             omc — command line interface
docs/schema.md       the open event format specification
```

## M1 · MCP server

ohmycontext can expose the whole context store to any MCP-capable client over
**stdio** (self-contained: runs one incremental scan, then serves) or **HTTP**
(served by the daemon at `http://127.0.0.1:27182/mcp` alongside
`/health` `/stats` `/ingest`).

Tools: `search_context`, `list_sessions`, `get_session`, `recent_activity`,
`list_artifacts`, `context_stats`.

### Claude Code

```sh
claude mcp add omc -- node /home/YOU/Github/ohmycontext/apps/cli/dist/index.js mcp
```

(add `--scope user` before `omc` to register it for all projects;
`--no-scan` after `mcp` skips the startup scan when the daemon is running.)

### Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.omc]
command = "node"
args = ["/home/YOU/Github/ohmycontext/apps/cli/dist/index.js", "mcp"]
```

### ChatGPT dev mode / Claude Desktop

These clients need a reachable URL, so point them at the daemon's HTTP
endpoint. Since the daemon binds to loopback only, expose it with a tunnel:

```sh
omc watch                                        # serves http://127.0.0.1:27182/mcp
cloudflared tunnel --url http://127.0.0.1:27182  # or: ngrok http --host-header=rewrite 27182
```

then register `https://<your-tunnel-host>/mcp` as the MCP server URL.

> **Warning:** anyone who obtains the tunnel URL gets full read access to your
> entire captured conversation history and the message bus. Prefer a named
> tunnel with an access policy (e.g. Cloudflare Access) over a quick tunnel,
> keep quick tunnels temporary, and never publish the URL. The daemon's Host
> check requires tunnels to rewrite the Host header to loopback (cloudflared
> does this by default; ngrok needs `--host-header=rewrite`).

### Security policy (daemon)

The daemon is loopback-only *and* additionally guards every route: the Host
header must be `127.0.0.1`/`localhost` (DNS-rebinding protection); requests
with an Origin header are 403 unless it is a browser-extension origin
(`chrome-extension://`, `moz-extension://`, `safari-web-extension://`), which
keeps random websites from reading or posting while letting the extension
work; POST bodies must be JSON/NDJSON (no cross-origin simple forms).
Origin-less local tools (curl, node, MCP clients) are unaffected.

## M2 · Web capture (browser extension) + artifact watching

### Browser extension (`apps/extension`)

A Manifest-V3 extension (built with WXT, vanilla TS) that auto-captures
conversations while you chat on **chatgpt.com** and **claude.ai**. A page-world
hook observes the site's own backend API responses (no DOM scraping); after any
streaming reply completes it refetches the full conversation JSON, normalizes it
into open-format events, and the background worker POSTs JSONL batches to the
daemon's `POST /ingest`. Re-sends are free (the daemon dedupes by id). If the
daemon is offline, events queue locally (FIFO, ~5MB cap) and flush with backoff
on the next success.

**Privacy:** everything stays on your machine — the only network target is your
loopback daemon (`127.0.0.1:27182` by default, configurable in the popup).

Load it:

```sh
pnpm install && pnpm build          # produces apps/extension/.output/chrome-mv3
```

then in Chrome/Edge: `chrome://extensions` → enable **Developer mode** →
**Load unpacked** → select `apps/extension/.output/chrome-mv3`.

The popup shows daemon connectivity, events sent/queued counters, a capture
on/off toggle, the daemon URL, and a "capture this tab" button.

Verification status: the normalization core, daemon ingest path, queueing
logic, and the extension build are verified (see repo history); live capture
against the real chatgpt.com/claude.ai frontends needs dogfooding — site APIs
change without notice, so the fetch hooks in
`apps/extension/entrypoints/pagehook.content.ts` are the first thing to check
if capture stops.

### Artifact directory watching

The daemon also watches artifact directories — default `~/Documents/ChatGPT`
(when it exists), plus anything in `OMC_ARTIFACT_DIRS` (colon-separated) — and
emits an Artifact event (kind from file extension, sha256 hash, size) for every
new or content-changed file (dotfiles and files >500MB skipped). Artifacts are
attributed to a session when a session's `cwd` is a path prefix of the file's
directory and the file's mtime falls inside the session's
`[startedAt, endedAt + 30min]` window. Ids are content-addressed
(`sha256('fs-artifact:' + path + ':' + hash)`), so rescans never duplicate.

## M3 · AI↔AI message bus

Agents can leave each other messages on named channels and poll for replies —
all local, SQLite-backed, and mirrored into the context store (source
`omc-bus`, one session `#<channel>` per channel) so bus traffic is searchable
and exportable like everything else.

Four MCP tools: `bus_post` (stable sender name + optional `clientMsgId` for
idempotent retries), `bus_read` (cursor-based: remember `latestSeq`, pass it
back as `afterSeq`), `bus_wait` (server-side long-poll, ≤60s), `bus_channels`.
Plain HTTP for non-MCP clients: `POST /bus/post`, `GET /bus/read`,
`GET /bus/channels` on the daemon.

Recipe — Codex finishes a task and wants a review:

1. Codex (via MCP or `curl -X POST …/bus/post`): `bus_post` to channel
   `review` with `sender: "codex"`, the summary as `content`, and the diff's
   artifact paths in `refs`.
2. Claude Code (or ChatGPT via tunnel, or you) has `bus_wait`-blocked on
   `review`; it wakes with the message, reviews, and `bus_post`s back.
3. Codex's next `bus_wait` resolves with the verdict.

Since MCP has no push, near-realtime relay = polling: an agent with a
scheduler (Claude Code cron, Codex automations, a wrapper script) can call
`bus_wait` on a cadence for minute-level responsiveness without burning API
calls while idle.

## Roadmap

- **M0** — local capture (CLI agents), open JSONL event format, SQLite + FTS5,
  search/export CLI, local HTTP ingest API.
- **M1** — MCP server (stdio + HTTP) exposing the unified context store to any
  MCP-capable client.
- **M2** — browser extension capturing chatgpt.com / claude.ai conversations;
  daemon-side artifact directory watching with session attribution.
- **M3 (this repo)** — AI↔AI local message bus: channels + cursors + long-poll,
  over MCP tools and plain HTTP, mirrored into the store.

## Development

```sh
pnpm dev watch --once     # run CLI from source via tsx
pnpm build                # build all packages (tsup)
pnpm clean
```

## License

Apache-2.0 — see [LICENSE](LICENSE).
