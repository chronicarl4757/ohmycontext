import { createHash } from 'node:crypto';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function sessionId(source: string, externalId: string): string {
  return sha256Hex(`session:${source}:${externalId}`);
}

export function messageId(source: string, sessionExternalId: string, nativeId: string): string {
  return sha256Hex(`message:${source}:${sessionExternalId}:${nativeId}`);
}

export function contentMessageId(parts: {
  source: string;
  sessionExternalId: string;
  role: string;
  createdAt: string;
  content: string;
  seq?: string | number;
}): string {
  return sha256Hex(
    `message:${parts.source}:${parts.sessionExternalId}:${parts.role}:${parts.createdAt}:${parts.seq ?? ''}:${parts.content}`,
  );
}

export function artifactId(parts: {
  source: string;
  sessionExternalId: string;
  nativeMessageId?: string;
  kind: string;
  ref: string;
}): string {
  return sha256Hex(
    `artifact:${parts.source}:${parts.sessionExternalId}:${parts.nativeMessageId ?? ''}:${parts.kind}:${parts.ref}`,
  );
}
