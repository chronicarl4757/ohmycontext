# ohmycontext Event Format (OMC-EF), Version 1

**Status:** Draft — proposed community standard.
**Format name:** `omc-jsonl`. **Media type (informal):** `application/x.omc+jsonl`.

## Abstract

This document specifies the ohmycontext event format: a line-delimited JSON
interchange format for capturing conversations between developers and AI
systems (coding agents, chat assistants, tools) in a vendor-neutral way. The
format is designed to be append-only, idempotent under redelivery, and simple
enough that any producer — a CLI agent log tailer, a browser extension, an IDE
plugin — can emit it with a JSON serializer and nothing else.

The key words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** in this document
are to be interpreted as described in RFC 2119.

## 1. Terminology

- **Session** — a coherent conversation instance with one AI system, as
  identified by the producing tool (e.g. one Claude Code session file, one
  Codex rollout).
- **Message** — a single turn element inside a session: user input, assistant
  output, system instruction, or a tool invocation/result.
- **Artifact** — a side-effect or referenced object: a file written, a URL
  fetched, an image produced.
- **Event** — the envelope wrapping one entity for transport/storage.
- **Producer** — anything that emits events. **Consumer** — anything that
  ingests them.
- **Source** — a short lowercase identifier of the producing tool family,
  e.g. `claude-code`, `codex`.

## 2. Transport encoding

1. A stream or file in this format consists of UTF-8 encoded lines, each
   terminated by a single LF (`\n`) character. CRLF producers MUST strip CR.
2. Each line MUST be exactly one JSON object (no pretty printing, no
   concatenated JSON, no line wrapping).
3. Lines MUST NOT be empty. Consumers MUST ignore blank lines if encountered.
4. A line that is not yet LF-terminated (partial write at the tail of a file)
   MUST NOT be parsed; tailing consumers resume at the last complete line.
5. Consumers MUST skip lines that fail JSON parsing or schema validation
   without aborting the stream.

## 3. Envelope

Every line is an **event envelope**:

```json
{"v":1,"type":"session|message|artifact","data":{ ...entity... }}
```

| Field  | Type   | Required | Description                                   |
| ------ | ------ | -------- | --------------------------------------------- |
| `v`    | number | yes      | format version; MUST be `1` for this document |
| `type` | string | yes      | one of `session`, `message`, `artifact`       |
| `data` | object | yes      | the entity, validated per §4 by `type`        |

Consumers MUST reject envelopes with an unknown `v`. Consumers MUST ignore
envelopes with unknown `type` values (forward compatibility).

## 4. Entities

All timestamps are ISO-8601 strings. Producers SHOULD emit UTC with a `Z`
suffix and millisecond precision; consumers MUST accept any valid ISO-8601 and
SHOULD normalize to UTC for ordering (lexicographic order on normalized UTC
strings is chronological).

All entity ids are lowercase hex SHA-256 digests (64 hex chars). Generation
rules are in §5.

`metadata`, where present, is an arbitrary string-keyed JSON object for
producer-specific data (e.g. git branch, tool names, source-native uuids).
Consumers MUST preserve it but MUST NOT depend on any particular key.

### 4.1 Session

| Field        | Type   | Required | Description                                        |
| ------------ | ------ | -------- | -------------------------------------------------- |
| `id`         | sha256 | yes      | §5.1                                               |
| `source`     | string | yes      | producer tool family, e.g. `claude-code`           |
| `externalId` | string | yes      | the session id assigned by the producing tool      |
| `title`      | string | no       | human-readable title, if the tool provides one     |
| `cwd`        | string | no       | working directory the session ran in               |
| `startedAt`  | iso    | yes      | timestamp of the first known activity              |
| `endedAt`    | iso    | no       | timestamp of the last known activity               |
| `model`      | string | no       | primary model identifier, if known                 |
| `metadata`   | object | no       | producer-specific extras                           |

Sessions are **upserted**: a consumer receiving a session event whose `id`
already exists SHOULD merge it (earliest `startedAt`, latest `endedAt`,
fill missing `title`/`cwd`/`model`), because incremental producers discover
session facts progressively.

### 4.2 Message

| Field         | Type   | Required | Description                                          |
| ------------- | ------ | -------- | ---------------------------------------------------- |
| `id`          | sha256 | yes      | §5.2                                                 |
| `sessionId`   | sha256 | yes      | `id` of the containing Session                       |
| `role`        | enum   | yes      | `user` \| `assistant` \| `system` \| `tool`          |
| `content`     | string | yes      | normalized plain text (see below)                    |
| `contentType` | enum   | yes*     | `text` \| `tool_use` \| `tool_result` (default `text`) |
| `createdAt`   | iso    | yes      | when the message was produced                        |
| `model`       | string | no       | model that generated this message                    |
| `tokenUsage`  | object | no       | `{input?: int, output?: int}`                        |
| `parentId`    | string | no       | `id` of a parent Message (e.g. result → its call)    |
| `metadata`    | object | no       | producer-specific extras                             |

Normalization rules:

- `content` is **plain text**. Rich blocks are flattened: text blocks are
  concatenated; `tool_use` becomes a readable serialization of the tool name
  plus its key arguments (e.g. `Read(file_path=/src/a.ts)`); `tool_result`
  becomes its textual payload.
- `tool_use` messages use `role: assistant`; `tool_result` messages use
  `role: tool`.
- Thinking/reasoning blocks SHOULD be dropped (they are not conversational
  content); producers MAY retain them under `metadata`.

### 4.3 Artifact

| Field       | Type   | Required | Description                              |
| ----------- | ------ | -------- | ---------------------------------------- |
| `id`        | sha256 | yes      | §5.3                                     |
| `sessionId` | sha256 | no       | owning Session, if known                 |
| `messageId` | sha256 | no       | Message that produced/referenced it      |
| `kind`      | enum   | yes      | `file` \| `url` \| `image` \| `other`    |
| `path`      | string | no       | filesystem path (for `kind: file`)       |
| `uri`       | string | no       | URI (for `kind: url`/`image`)            |
| `hash`      | string | no       | content hash, if the producer knows it   |
| `bytes`     | int    | no       | size in bytes, if known                  |
| `createdAt` | iso    | yes      | when the artifact was observed           |
| `metadata`  | object | no       | producer-specific extras                 |

Artifacts reference content; they do not embed it. Producers MUST NOT inline
file contents into artifacts.

## 5. Identifier generation

Ids MUST be deterministic: re-parsing the same source data MUST reproduce the
same ids. This is what makes the format idempotent (§6). Inputs are joined
with `:` and hashed as UTF-8; the digest is hex-encoded lowercase.

1. **Session:** `sha256("session:" + source + ":" + externalId)`
2. **Message:**
   - if the source provides a stable native message id:
     `sha256("message:" + source + ":" + sessionExternalId + ":" + nativeId)`
   - otherwise a content fallback:
     `sha256("message:" + source + ":" + sessionExternalId + ":" + role + ":" + createdAt + ":" + seq + ":" + content)`
     where `seq` is a source-native ordering hint (e.g. a line ordinal) or the
     empty string.
3. **Artifact:**
   `sha256("artifact:" + source + ":" + sessionExternalId + ":" + nativeMessageId + ":" + kind + ":" + ref)`
   where `ref` is the path or URI and `nativeMessageId` may be empty.

Consumers MUST treat two events with the same entity `id` as the same entity.

## 6. Invariants

1. **Append-only.** Events are facts. An event, once emitted, is never
   modified or retracted within the format. Corrections are new events
   (session merges, §4.1).
2. **Idempotent by id.** Applying the same event twice MUST have the same
   effect as applying it once. Consumers implement this with
   insert-if-absent semantics keyed on entity `id`.
3. **Self-delimiting.** Every line is independently parseable; no line
   depends on the framing of another.
4. **Offset-resumable.** A consumer tailing a live file records byte offsets;
   because of §2.4 it can always resume safely after a crash.
5. **Order-tolerant.** Producers SHOULD emit events in chronological order,
   but consumers MUST NOT require it (messages may reference a session whose
   event arrives later).

## 7. Versioning

`v` is a single integer, bumped only for incompatible changes (removed fields,
changed semantics). New optional entity fields and new `metadata` keys are
compatible changes and do not bump `v`. Producers of future versions MUST NOT
send `v > 1` envelopes to a `v = 1` consumer.

## 8. Extensibility

- New sources are introduced simply by emitting events with a new `source`
  string; no registry is required. Sources SHOULD be lowercase, hyphenated.
  Sources emitted by the reference implementation: `claude-code`, `codex`
  (CLI log connectors), `chatgpt-web`, `claude-web`, `deepseek-web`,
  `kimi-web` (browser extension), `omc-bus` (message-bus mirror, §8.2).
- New entity fields: producers MAY add fields; consumers MUST ignore unknown
  fields (they MAY strip them when normalizing into storage).
- New envelope `type`s MUST be ignored by `v = 1` consumers.

### 8.1 Producer id namespaces

Producers that synthesize entities without a source-native conversation id MAY
use their own id namespaces, prefixed to avoid collisions. The reference
implementation uses `fs-artifact:<path>:<content-sha256>` (hex-hashed) for
filesystem-watcher artifacts, where re-emitting is idempotent by construction.

### 8.2 Message-bus mirroring (`omc-bus`)

The local AI↔AI message bus (channels of timestamped messages) mirrors every
bus message into the event stream as follows:

- **Source** `omc-bus`; one **session per channel**: `externalId` is
  `bus:<channel>`, `title` is `#<channel>`.
- Each bus message becomes a **message event** with `role: user` (bus messages
  are sender-neutral), `createdAt` from the bus post, and
  `metadata: {sender, refs?}`.
- Bus ids live in their own namespace: `bus:<sender>:<clientMsgId>` when the
  producer supplies an idempotency key (retries dedupe by id), otherwise
  `bus:<sender>:<createdAt>:<content-sha256>`.

Consumers MUST treat bus mirror events like any other events; the bus's
canonical record additionally lives in the consumer-local `bus_messages` table
(which carries the monotonically increasing `seq` cursor used for polling).

## 9. Examples

```jsonl
{"v":1,"type":"session","data":{"id":"9b2e…","source":"claude-code","externalId":"a029ff93-…","title":"fix login redirect","cwd":"/home/alice/app","startedAt":"2026-10-01T09:12:03.441Z","model":"claude-sonnet-4-5"}}
{"v":1,"type":"message","data":{"id":"1c77…","sessionId":"9b2e…","role":"user","content":"Why does /login loop?","contentType":"text","createdAt":"2026-10-01T09:12:10.002Z"}}
{"v":1,"type":"message","data":{"id":"77aa…","sessionId":"9b2e…","role":"assistant","content":"Read(file_path=/src/auth.ts)","contentType":"tool_use","createdAt":"2026-10-01T09:12:11.930Z","metadata":{"tool":"Read"}}}
{"v":1,"type":"artifact","data":{"id":"e0d1…","sessionId":"9b2e…","messageId":"77aa…","kind":"file","path":"/src/auth.ts","createdAt":"2026-10-01T09:12:11.930Z"}}
```

(Ids above are abbreviated for readability; real ids are 64 hex chars.)

## Appendix A. Enumerations

- `role`: `user`, `assistant`, `system`, `tool`
- `contentType`: `text`, `tool_use`, `tool_result`
- `artifact.kind`: `file`, `url`, `image`, `other`

## Appendix B. Reference implementation

The zod schemas in `packages/core/src/schema.ts` are the normative reference
implementation of this specification; where this prose and the schema
disagree, the schema wins for `v = 1` and the discrepancy is a spec bug.
