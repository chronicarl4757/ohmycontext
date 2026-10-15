import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Command } from 'commander';
import { DEFAULT_PORT } from '@ohmycontext/daemon';

const UNIT_NAME = 'ohmycontext.service';

function unitDir(): string {
  return join(homedir(), '.config', 'systemd', 'user');
}

function unitPath(): string {
  return join(unitDir(), UNIT_NAME);
}

/** argv[1] is apps/cli/{dist,src}/index.* — the repo root is three levels up */
function resolveEntry(): { entry: string; root: string } | null {
  const argv1 = process.argv[1] ?? '';
  const root = resolve(dirname(argv1), '..', '..', '..');
  const entry = join(root, 'apps', 'cli', 'dist', 'index.js');
  return existsSync(entry) ? { entry, root } : null;
}

function systemctl(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((res) => {
    execFile('systemctl', ['--user', ...args], { timeout: 15_000 }, (err, stdout, stderr) => {
      const code = err && typeof err.code === 'number' ? err.code : err ? 1 : 0;
      res({ code, out: `${stdout}\n${stderr}`.trim() });
    });
  });
}

async function systemdAvailable(): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  const r = await systemctl(['is-system-running']);
  // "running"/"degraded" have a user bus; nonzero/offline means no systemd --user
  return r.code === 0 || /^(running|degraded|starting)$/.test(r.out);
}

function unitText(entry: string, root: string): string {
  return `[Unit]
Description=ohmycontext daemon (local AI context layer)
After=default.target

[Service]
ExecStart=${process.execPath} ${entry} watch
Restart=on-failure
RestartSec=5
WorkingDirectory=${root}

[Install]
WantedBy=default.target
`;
}

async function daemonAlive(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

const MANUAL_HINTS = [
  'no systemd --user bus here (container?) — alternatives:',
  `  nohup node <repo>/apps/cli/dist/index.js watch >/dev/null 2>&1 &`,
  '  or a @reboot cron line / pm2 / your init system of choice',
];

export function registerServiceCommand(program: Command): void {
  const service = program.command('service').description('manage the systemd --user daemon unit');

  service
    .command('install')
    .description('install + enable the ohmycontext daemon as a user service')
    .option('--json')
    .action(async (opts: { json?: boolean }) => {
      const resolved = resolveEntry();
      const hints: string[] = [];
      if (!resolved) {
        const msg = 'built CLI not found — run pnpm build first';
        if (opts.json) console.log(JSON.stringify({ installed: false, error: msg }));
        else console.error(msg);
        process.exitCode = 1;
        return;
      }
      if (!(await systemdAvailable())) {
        if (opts.json) console.log(JSON.stringify({ installed: false, error: 'no-systemd', hints: MANUAL_HINTS }, null, 2));
        else MANUAL_HINTS.forEach((h) => console.error(h));
        process.exitCode = 1;
        return;
      }
      const port = Number(process.env.OMC_PORT) || DEFAULT_PORT;
      const portBusy = await daemonAlive(port);
      await mkdir(unitDir(), { recursive: true });
      await writeFile(unitPath(), unitText(resolved.entry, resolved.root));
      await systemctl(['daemon-reload']);
      let started = false;
      if (portBusy) {
        hints.push(
          `port ${port} already serves a running daemon — unit installed but NOT started (stop the other daemon, then: systemctl --user start ohmycontext)`,
        );
      } else {
        const r = await systemctl(['enable', '--now', UNIT_NAME]);
        started = r.code === 0;
        if (!started) hints.push(`enable --now failed: ${r.out}`);
      }
      const out = { installed: true, started, portBusy, unitPath: unitPath(), entry: resolved.entry, hints };
      if (opts.json) console.log(JSON.stringify(out, null, 2));
      else {
        console.log(`unit written: ${out.unitPath}`);
        console.log(`exec: ${process.execPath} ${resolved.entry} watch`);
        if (started) console.log('enabled + started');
        hints.forEach((h) => console.log(`warning: ${h}`));
      }
    });

  service
    .command('uninstall')
    .description('stop + disable + remove the unit')
    .option('--json')
    .action(async (opts: { json?: boolean }) => {
      const existed = existsSync(unitPath());
      if (await systemdAvailable()) {
        await systemctl(['disable', '--now', UNIT_NAME]);
      }
      if (existed) await rm(unitPath());
      if (await systemdAvailable()) await systemctl(['daemon-reload']);
      if (opts.json) console.log(JSON.stringify({ removed: existed }));
      else console.log(existed ? `removed ${unitPath()}` : 'unit was not installed');
    });

  service
    .command('status')
    .description('unit + daemon status')
    .option('--json')
    .action(async (opts: { json?: boolean }) => {
      const installed = existsSync(unitPath());
      const hasSystemd = await systemdAvailable();
      const port = Number(process.env.OMC_PORT) || DEFAULT_PORT;
      const alive = await daemonAlive(port);
      let active: string | null = null;
      let enabled: string | null = null;
      let logTail: string[] = [];
      if (hasSystemd) {
        active = (await systemctl(['is-active', UNIT_NAME])).out || null;
        enabled = (await systemctl(['is-enabled', UNIT_NAME])).out || null;
        const j = await new Promise<{ code: number; out: string }>((res) => {
          execFile(
            'journalctl',
            ['--user', '-u', UNIT_NAME, '-n', '5', '--no-pager', '--output=short-iso'],
            { timeout: 15_000 },
            (err, stdout) => res({ code: err ? 1 : 0, out: stdout ?? '' }),
          );
        });
        logTail = j.out.split('\n').filter((l) => l.trim()).slice(-5);
      }
      const out = { installed, systemd: hasSystemd, active, enabled, daemonAlive: alive, port, logTail };
      if (opts.json) {
        console.log(JSON.stringify(out, null, 2));
      } else {
        console.log(`unit: ${installed ? `installed (${unitPath()})` : 'not installed'}`);
        console.log(`systemd --user: ${hasSystemd ? 'yes' : 'no'}`);
        if (hasSystemd) console.log(`active: ${active ?? '-'} · enabled: ${enabled ?? '-'}`);
        console.log(`daemon on 127.0.0.1:${port}: ${alive ? 'responding' : 'not responding'}`);
        for (const l of logTail) console.log(`  ${l}`);
      }
      if (!installed || !alive) process.exitCode = 1;
    });
}
