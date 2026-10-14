import { watch, type FSWatcher } from 'chokidar';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { sha256Hex, type OmcStore } from '@ohmycontext/core';

export const FS_ARTIFACT_SOURCE = 'fs-artifact';
const MAX_FILE_BYTES = 500 * 1024 * 1024;
const DEBOUNCE_MS = 300;

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif']);

export function artifactDirs(): string[] {
  const dirs: string[] = [];
  const fallback = join(homedir(), 'Documents', 'ChatGPT');
  if (existsSync(fallback)) dirs.push(fallback);
  const env = process.env.OMC_ARTIFACT_DIRS;
  if (env) {
    for (const raw of env.split(':')) {
      const dir = raw.trim();
      if (dir && !dirs.includes(dir)) {
        if (existsSync(dir)) dirs.push(dir);
        // missing env dirs are silently skipped; the default is the only implicit one
      }
    }
  }
  return dirs;
}

export function artifactKindFor(filePath: string): 'file' | 'image' | 'other' {
  const ext = extname(filePath).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  return ext ? 'file' : 'other';
}

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const h = createHash('sha256');
    createReadStream(filePath)
      .on('data', (chunk) => h.update(chunk))
      .on('error', rejectPromise)
      .on('end', () => resolvePromise(h.digest('hex')));
  });
}

async function* walkFiles(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    try {
      if (e.isDirectory()) yield* walkFiles(p);
      else if (e.isFile()) yield p;
    } catch {
      // vanished mid-walk; skip
    }
  }
}

/**
 * Emits an Artifact event for one file when it is new or its (size, mtime)
 * changed since the last scan (cached in sync_state under 'fs-artifact').
 * The artifact id hashes path+content, so re-scans are naturally idempotent.
 */
export async function emitArtifact(
  store: OmcStore,
  filePath: string,
): Promise<'new' | 'dup' | 'skip' | 'error'> {
  let st;
  try {
    st = await stat(filePath);
  } catch {
    return 'skip';
  }
  if (!st.isFile() || st.size > MAX_FILE_BYTES) return 'skip';
  const mtime = Math.round(st.mtimeMs);
  const prev = store.getSyncState(FS_ARTIFACT_SOURCE, filePath);
  if (prev && prev.mtime === mtime && prev.byteOffset === st.size) return 'skip';
  try {
    const hash = await hashFile(filePath);
    const mtimeIso = new Date(st.mtimeMs).toISOString();
    const createdAt =
      st.birthtimeMs > 0 ? new Date(st.birthtimeMs).toISOString() : mtimeIso;
    const sessionId = store.attributeSessionId(dirname(filePath), mtimeIso);
    const res = store.ingest([
      {
        v: 1,
        type: 'artifact',
        data: {
          id: sha256Hex(`fs-artifact:${filePath}:${hash}`),
          ...(sessionId ? { sessionId } : {}),
          kind: artifactKindFor(filePath),
          path: filePath,
          hash,
          bytes: st.size,
          createdAt,
          metadata: { watcher: FS_ARTIFACT_SOURCE, mtime: mtimeIso },
        },
      },
    ]);
    store.setSyncState(FS_ARTIFACT_SOURCE, filePath, st.size, mtime);
    return res.ingested > 0 ? 'new' : 'dup';
  } catch {
    return 'error';
  }
}

export async function scanArtifactDirs(
  store: OmcStore,
  log: (msg: string) => void,
): Promise<{ files: number; artifacts: number; errors: number }> {
  const out = { files: 0, artifacts: 0, errors: 0 };
  for (const dir of artifactDirs()) {
    for await (const file of walkFiles(dir)) {
      out.files++;
      const r = await emitArtifact(store, file);
      if (r === 'new') out.artifacts++;
      else if (r === 'error') out.errors++;
    }
  }
  if (out.artifacts > 0 || out.errors > 0) {
    log(`artifact scan: ${out.artifacts} new artifacts from ${out.files} files (${out.errors} errors)`);
  }
  return out;
}

export function watchArtifactDirs(store: OmcStore, log: (msg: string) => void): FSWatcher | null {
  const dirs = artifactDirs();
  if (dirs.length === 0) return null;
  const debouncers = new Map<string, ReturnType<typeof setTimeout>>();
  const watcher = watch(dirs, {
    ignoreInitial: true, // initial state is covered by scanArtifactDirs
    persistent: true,
    ignored: /(^|[\/\\])\../, // dotfiles
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });
  const onFile = (p: string) => {
    const existing = debouncers.get(p);
    if (existing) clearTimeout(existing);
    debouncers.set(
      p,
      setTimeout(() => {
        debouncers.delete(p);
        void emitArtifact(store, p).then((r) => {
          if (r === 'new') log(`+artifact ${p}`);
        });
      }, DEBOUNCE_MS),
    );
  };
  watcher.on('add', onFile);
  watcher.on('change', onFile);
  watcher.on('error', (err) => log(`artifact watcher error: ${err instanceof Error ? err.message : String(err)}`));
  for (const dir of dirs) log(`watching artifact dir ${dir}`);
  return watcher;
}
