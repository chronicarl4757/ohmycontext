import { open } from 'node:fs/promises';

export const MAX_CHUNK_BYTES = 8 * 1024 * 1024;

export interface TailResult {
  lines: string[];
  offset: number;
  size: number;
}

/**
 * Reads up to MAX_CHUNK_BYTES of new data starting at `offset` and returns the
 * complete LF-terminated lines found, plus the byte offset just past the last
 * complete line. A trailing partial line is left for a future read.
 */
export async function readNewLines(filePath: string, offset: number): Promise<TailResult> {
  const fh = await open(filePath, 'r');
  try {
    const { size } = await fh.stat();
    let start = offset;
    if (start < 0 || start > size) start = 0; // truncated or rotated: restart
    if (start === size) return { lines: [], offset: start, size };
    let toRead = Math.min(size - start, MAX_CHUNK_BYTES);
    let buf = Buffer.alloc(toRead);
    await fh.read(buf, 0, toRead, start);
    let nl = buf.lastIndexOf(0x0a);
    if (nl === -1 && toRead < size - start) {
      // a single line larger than the chunk: read the remainder whole
      const rest = Buffer.alloc(size - start - toRead);
      await fh.read(rest, 0, rest.length, start + toRead);
      buf = Buffer.concat([buf, rest]);
      nl = buf.lastIndexOf(0x0a);
    }
    if (nl === -1) return { lines: [], offset: start, size };
    // 0x0a never occurs inside a multi-byte UTF-8 sequence, so cutting at the
    // last newline byte keeps every returned line valid UTF-8.
    const complete = buf.subarray(0, nl + 1);
    const lines = complete.toString('utf8').split('\n');
    lines.pop(); // trailing '' after the final newline
    return { lines: lines.filter((l) => l.length > 0), offset: start + complete.length, size };
  } finally {
    await fh.close();
  }
}
