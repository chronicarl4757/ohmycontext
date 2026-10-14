import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { OMC_VERSION, OmcStore, type Session } from '@ohmycontext/core';
import { DEFAULT_PORT, runDaemon } from '@ohmycontext/daemon';
import { createMcpServer } from '@ohmycontext/mcp';

const program = new Command();

program
  .name('omc')
  .description('ohmycontext — local-first personal AI context layer')
  .version(OMC_VERSION);

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function withStore<T>(fn: (store: OmcStore) => T | Promise<T>): Promise<T> {
  const store = new OmcStore();
  const finish = async () => {
    try {
      return await fn(store);
    } finally {
      store.close();
    }
  };
  return finish();
}

function openBrowser(url: string): void {
  try {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    const child = spawn(cmd, [url], {
      detached: true,
      stdio: 'ignore',
      ...(process.platform === 'win32' ? { shell: true } : {}),
    });
    child.on('error', () => {}); // headless / no browser: the URL is printed anyway
    child.unref();
  } catch {
    // never crash over a browser
  }
}

program
  .command('watch')
  .description('watch AI tool logs and ingest new events (HTTP API on 127.0.0.1)')
  .option('--once', 'scan all files once and exit')
  .option('-p, --port <port>', 'HTTP port (env OMC_PORT)')
  .action(async (opts: { once?: boolean; port?: string }) => {
    const port = Number(opts.port ?? process.env.OMC_PORT) || DEFAULT_PORT;
    const summary = await runDaemon({ once: Boolean(opts.once), port });
    if (opts.once) {
      console.log(
        `scanned ${summary.files} files (${summary.filesChanged} changed) in ${(summary.durationMs / 1000).toFixed(1)}s`,
      );
      for (const [name, s] of Object.entries(summary.perSource)) {
        console.log(
          `  ${name}: ${s.files} files, ${s.ingested} new events (${s.skipped} duplicates, ${s.errors} errors)`,
        );
      }
      console.log(
        `total: ${summary.ingested} ingested, ${summary.skipped} skipped, ${summary.errors} errors`,
      );
    }
  });

program
  .command('ui')
  .description('open the web UI (starts the daemon first if not already running)')
  .option('-p, --port <port>', 'HTTP port (env OMC_PORT)')
  .action(async (opts: { port?: string }) => {
    const port = Number(opts.port ?? process.env.OMC_PORT) || DEFAULT_PORT;
    const url = `http://127.0.0.1:${port}/`;
    const health = () =>
      fetch(`http://127.0.0.1:${port}/health`)
        .then((r) => r.ok)
        .catch(() => false);
    if (await health()) {
      console.log(`\nomc ui → ${url}\n(daemon already running)\n`);
      openBrowser(url);
      return;
    }
    const daemonDone = runDaemon({ port });
    for (let i = 0; i < 480; i++) {
      if (await health()) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    console.log(`\nomc ui → ${url}\n`);
    openBrowser(url);
    await daemonDone;
  });

program
  .command('mcp')
  .description('serve the context store as an MCP server over stdio')
  .option('--no-scan', 'skip the incremental startup scan')
  .action(async (opts: { scan: boolean }) => {
    // stdio transport owns stdout; every log line must go to stderr
    if (opts.scan) {
      const summary = await runDaemon({ once: true });
      console.error(
        `[omc] startup scan: ${summary.ingested} new events from ${summary.filesChanged}/${summary.files} files`,
      );
    }
    const store = new OmcStore();
    const server = createMcpServer({ store });
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('[omc] mcp stdio server ready');
    await new Promise<void>((resolvePromise) => {
      process.once('SIGINT', () => resolvePromise());
      process.once('SIGTERM', () => resolvePromise());
      process.stdin.once('end', () => resolvePromise()); // client went away
      server.server.onclose = () => resolvePromise();
    });
    await server.close();
    store.close();
    process.exit(0);
  });

program
  .command('search')
  .description('full-text search across all captured messages')
  .argument('<query>', 'search terms')
  .option('-s, --source <source>', 'restrict to a source (e.g. claude-code, codex)')
  .option('-l, --limit <n>', 'max results', '20')
  .option('--json', 'emit JSON')
  .action(async (query: string, opts: { source?: string; limit: string; json?: boolean }) => {
    await withStore((store) => {
      const hits = store.search(query, {
        ...(opts.source ? { source: opts.source } : {}),
        limit: Number(opts.limit),
      });
      if (opts.json) {
        console.log(JSON.stringify(hits, null, 2));
        return;
      }
      if (hits.length === 0) {
        console.log('no matches');
        return;
      }
      for (const h of hits) {
        const where = h.title ?? h.cwd ?? h.sessionId.slice(0, 8);
        console.log(`[${h.source ?? '?'}] ${where} · ${h.role} · ${h.createdAt}`);
        console.log(`  ${oneLine(h.snippet || h.content).slice(0, 240)}`);
      }
    });
  });

program
  .command('sessions')
  .description('list captured sessions, most recent first')
  .option('-s, --source <source>', 'restrict to a source')
  .option('-l, --limit <n>', 'max sessions', '50')
  .option('--json', 'emit JSON')
  .action(async (opts: { source?: string; limit: string; json?: boolean }) => {
    await withStore((store) => {
      const sessions = store.listSessions({
        ...(opts.source ? { source: opts.source } : {}),
        limit: Number(opts.limit),
      });
      if (opts.json) {
        console.log(JSON.stringify(sessions, null, 2));
        return;
      }
      if (sessions.length === 0) {
        console.log('no sessions');
        return;
      }
      for (const s of sessions) {
        const label = oneLine(s.title ?? s.cwd ?? '').slice(0, 60) || '(untitled)';
        console.log(
          `${s.startedAt.slice(0, 16).replace('T', ' ')} · ${s.source.padEnd(12)} · ${label} · ${s.messageCount} msgs · ${s.id.slice(0, 8)}`,
        );
      }
    });
  });

program
  .command('stats')
  .description('show database counts, size and event time range')
  .option('--json', 'emit JSON')
  .action(async (opts: { json?: boolean }) => {
    await withStore((store) => {
      const st = store.stats();
      if (opts.json) {
        console.log(JSON.stringify(st, null, 2));
        return;
      }
      console.log(`db: ${st.dbPath} (${(st.dbBytes / 1024 / 1024).toFixed(1)} MiB)`);
      console.log(
        `totals: ${st.totals.events} events · ${st.totals.sessions} sessions · ${st.totals.messages} messages · ${st.totals.artifacts} artifacts`,
      );
      for (const s of st.sources) {
        console.log(`  ${s.source}: ${s.sessions} sessions, ${s.messages} messages, ${s.artifacts} artifacts`);
      }
      console.log(`range: ${st.earliest ?? '-'} → ${st.latest ?? '-'}`);
    });
  });

program
  .command('ingest')
  .description('import open-format JSONL files (reads stdin when no files given)')
  .argument('[files...]', 'JSONL files to import')
  .action(async (files: string[]) => {
    await withStore(async (store) => {
      const inputs: { name: string; text: string }[] = [];
      if (files.length === 0) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
        inputs.push({ name: '<stdin>', text: Buffer.concat(chunks).toString('utf8') });
      } else {
        for (const f of files) inputs.push({ name: f, text: await readFile(f, 'utf8') });
      }
      let totals = { ingested: 0, skipped: 0, unknown: 0, errors: 0 };
      for (const { name, text } of inputs) {
        const lines = text.split('\n').filter((l) => l.trim().length > 0);
        const events: unknown[] = [];
        let parseErrors = 0;
        for (const line of lines) {
          try {
            events.push(JSON.parse(line));
          } catch {
            parseErrors++;
          }
        }
        const r = store.ingest(events);
        const errs = r.errors.length + parseErrors;
        console.log(`${name}: ${r.ingested} ingested, ${r.skipped} skipped, ${errs} errors`);
        totals = {
          ingested: totals.ingested + r.ingested,
          skipped: totals.skipped + r.skipped,
          unknown: totals.unknown + r.unknown,
          errors: totals.errors + errs,
        };
      }
      console.log(`total: ${totals.ingested} ingested, ${totals.skipped} skipped, ${totals.errors} errors`);
      if (totals.unknown > 0) {
        console.error(`warning: skipped ${totals.unknown} event(s) with unknown type (see docs/schema.md §8)`);
      }
      if (totals.errors > 0) process.exitCode = 1;
    });
  });

function yamlStr(s: string): string {
  return JSON.stringify(s);
}

function slug(s: string): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return out || 'session';
}

function renderSessionMd(store: OmcStore, s: Session): string {
  const msgs = store.getMessages({ sessionId: s.id });
  const arts = store.getArtifacts({ sessionId: s.id });
  const fm = [
    '---',
    `id: ${s.id}`,
    `source: ${s.source}`,
    `externalId: ${yamlStr(s.externalId)}`,
    ...(s.title ? [`title: ${yamlStr(s.title)}`] : []),
    ...(s.cwd ? [`cwd: ${yamlStr(s.cwd)}`] : []),
    `startedAt: ${s.startedAt}`,
    ...(s.endedAt ? [`endedAt: ${s.endedAt}`] : []),
    ...(s.model ? [`model: ${yamlStr(s.model)}`] : []),
    '---',
  ].join('\n');
  const body = msgs.map((m) => `### ${m.role} · ${m.createdAt}\n\n${m.content}`).join('\n\n');
  const artSection =
    arts.length > 0
      ? `\n\n## Artifacts\n\n${arts.map((a) => `- ${a.path ?? a.uri ?? a.id} (${a.kind})`).join('\n')}`
      : '';
  return `${fm}\n\n# ${s.title ?? s.cwd ?? s.id}\n\n${body}${artSection}\n`;
}

program
  .command('export')
  .description('export sessions as markdown, JSONL (open format), or JSON')
  .option('-f, --format <fmt>', 'md | jsonl | json', 'md')
  .option('--session <id>', 'session id or unique prefix')
  .option('-o, --out <path>', 'output file (single session) or directory')
  .action(async (opts: { format: string; session?: string; out?: string }) => {
    await withStore(async (store) => {
      let sessionId: string | undefined;
      if (opts.session) {
        const resolved = store.resolveSessionId(opts.session);
        if (!resolved) {
          console.error(`session not found or prefix ambiguous: ${opts.session}`);
          process.exitCode = 1;
          return;
        }
        sessionId = resolved;
      }
      if (opts.format === 'jsonl') {
        const lines = store.rawEvents(sessionId ? { sessionId } : {});
        const text = lines.length > 0 ? `${lines.join('\n')}\n` : '';
        if (opts.out) {
          await writeFile(opts.out, text);
          console.error(`exported ${lines.length} events → ${opts.out}`);
        } else {
          process.stdout.write(text);
        }
      } else if (opts.format === 'json') {
        const filter = sessionId ? { sessionId } : {};
        const doc = {
          sessions: store.getSessions(filter),
          messages: store.getMessages(filter),
          artifacts: store.getArtifacts(filter),
        };
        const text = `${JSON.stringify(doc, null, 2)}\n`;
        if (opts.out) {
          await writeFile(opts.out, text);
          console.error(`exported → ${opts.out}`);
        } else {
          process.stdout.write(text);
        }
      } else if (opts.format === 'md') {
        const sessions = store.getSessions(sessionId ? { sessionId } : {});
        if (sessions.length === 0) {
          console.error('no sessions found');
          process.exitCode = 1;
          return;
        }
        if (sessionId) {
          const first = sessions[0];
          if (!first) return;
          const out = opts.out ?? `omc-${sessionId.slice(0, 8)}.md`;
          await writeFile(out, renderSessionMd(store, first));
          console.log(`wrote ${out}`);
        } else {
          const dir = opts.out ?? `omc-export-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
          await mkdir(dir, { recursive: true });
          for (const s of sessions) {
            const fname = `${s.startedAt.slice(0, 10)}-${slug(s.title ?? s.cwd ?? '')}-${s.id.slice(0, 8)}.md`;
            await writeFile(join(dir, fname), renderSessionMd(store, s));
          }
          console.log(`wrote ${sessions.length} session(s) → ${dir}`);
        }
      } else {
        console.error(`unknown format: ${opts.format} (expected md, jsonl, or json)`);
        process.exitCode = 1;
      }
    });
  });

await program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
