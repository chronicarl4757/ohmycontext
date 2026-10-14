import { z } from 'zod';

export const OMC_FORMAT_VERSION = 1 as const;

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'expected a sha256 hex digest');
const isoDate = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: 'expected an ISO-8601 date string' });
const metadata = z.record(z.string(), z.unknown());

export const RoleSchema = z.enum(['user', 'assistant', 'system', 'tool']);
export const ContentTypeSchema = z.enum(['text', 'tool_use', 'tool_result']);
export const ArtifactKindSchema = z.enum(['file', 'url', 'image', 'other']);

export const SessionSchema = z.object({
  id: sha256Hex,
  source: z.string().min(1),
  externalId: z.string().min(1),
  title: z.string().optional(),
  cwd: z.string().optional(),
  startedAt: isoDate,
  endedAt: isoDate.optional(),
  model: z.string().optional(),
  metadata: metadata.optional(),
});

export const TokenUsageSchema = z.object({
  input: z.number().int().nonnegative().optional(),
  output: z.number().int().nonnegative().optional(),
});

export const MessageSchema = z.object({
  id: sha256Hex,
  sessionId: sha256Hex,
  role: RoleSchema,
  content: z.string(),
  contentType: ContentTypeSchema.default('text'),
  createdAt: isoDate,
  model: z.string().optional(),
  tokenUsage: TokenUsageSchema.optional(),
  parentId: z.string().optional(),
  metadata: metadata.optional(),
});

export const ArtifactSchema = z.object({
  id: sha256Hex,
  sessionId: sha256Hex.optional(),
  messageId: sha256Hex.optional(),
  kind: ArtifactKindSchema,
  path: z.string().optional(),
  uri: z.string().optional(),
  hash: z.string().optional(),
  bytes: z.number().int().nonnegative().optional(),
  createdAt: isoDate,
  metadata: metadata.optional(),
});

export const OmcEventSchema = z.discriminatedUnion('type', [
  z.object({ v: z.literal(OMC_FORMAT_VERSION), type: z.literal('session'), data: SessionSchema }),
  z.object({ v: z.literal(OMC_FORMAT_VERSION), type: z.literal('message'), data: MessageSchema }),
  z.object({ v: z.literal(OMC_FORMAT_VERSION), type: z.literal('artifact'), data: ArtifactSchema }),
]);

// loose first-pass envelope: unknown `type` values are ignored per spec §3/§8
export const EventEnvelopeSchema = z.object({
  v: z.literal(OMC_FORMAT_VERSION),
  type: z.string(),
  data: z.unknown(),
});

export type Role = z.infer<typeof RoleSchema>;
export type ContentType = z.infer<typeof ContentTypeSchema>;
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;
export type Session = z.infer<typeof SessionSchema>;
export type TokenUsage = z.infer<typeof TokenUsageSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type Artifact = z.infer<typeof ArtifactSchema>;
export type OmcEvent = z.infer<typeof OmcEventSchema>;
