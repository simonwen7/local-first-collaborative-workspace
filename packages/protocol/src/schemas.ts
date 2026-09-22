import { z } from 'zod';

export const MAX_DOCUMENT_ID_LENGTH = 64;
export const MAX_CLIENT_ID_LENGTH = 128;
export const MAX_OPERATION_ID_LENGTH = 256;
export const MAX_ELEMENT_ID_LENGTH = 256;
export const MAX_OPERATION_VALUE_LENGTH = 16384;
export const MAX_CAPABILITY_LENGTH = 64;
export const MAX_CAPABILITIES = 16;
export const MAX_DISPLAY_NAME_LENGTH = 40;
export const MAX_PRESENCE_PARTICIPANTS = 64;

export const SNAPSHOT_BOOTSTRAP_CAPABILITY = 'snapshot-bootstrap-v1' as const;

const boundedString = (max: number) => z.string().min(1).max(max);

const positiveSafeInteger = z
  .number()
  .int()
  .positive()
  .refine((value) => Number.isSafeInteger(value), {
    message: 'must be a positive safe integer',
  });

const nonNegativeSafeInteger = z
  .number()
  .int()
  .nonnegative()
  .refine((value) => Number.isSafeInteger(value), {
    message: 'must be a non-negative safe integer',
  });

export const insertOperationSchema = z.object({
  kind: z.literal('insert'),
  opId: boundedString(MAX_OPERATION_ID_LENGTH),
  clientId: boundedString(MAX_CLIENT_ID_LENGTH),
  counter: positiveSafeInteger,
  lamport: positiveSafeInteger,
  afterId: boundedString(MAX_ELEMENT_ID_LENGTH),
  value: boundedString(MAX_OPERATION_VALUE_LENGTH),
});

export const deleteOperationSchema = z.object({
  kind: z.literal('delete'),
  opId: boundedString(MAX_OPERATION_ID_LENGTH),
  clientId: boundedString(MAX_CLIENT_ID_LENGTH),
  counter: positiveSafeInteger,
  lamport: positiveSafeInteger,
  targetId: boundedString(MAX_ELEMENT_ID_LENGTH),
});

export const textOperationSchema = z.discriminatedUnion('kind', [
  insertOperationSchema,
  deleteOperationSchema,
]);

const capabilitySchema = z.string().min(1).max(MAX_CAPABILITY_LENGTH);

export const joinMessageSchema = z.object({
  type: z.literal('join'),
  documentId: boundedString(MAX_DOCUMENT_ID_LENGTH),
  clientId: boundedString(MAX_CLIENT_ID_LENGTH),
  lastServerSeq: nonNegativeSafeInteger,
  capabilities: z.array(capabilitySchema).max(MAX_CAPABILITIES).optional(),
  displayName: boundedString(MAX_DISPLAY_NAME_LENGTH).optional(),
});

export const submitOperationMessageSchema = z.object({
  type: z.literal('submit-operation'),
  documentId: boundedString(MAX_DOCUMENT_ID_LENGTH),
  operation: textOperationSchema,
});

export const clientMessageSchema = z.discriminatedUnion('type', [
  joinMessageSchema,
  submitOperationMessageSchema,
]);

export const sequencedOperationSchema = z.object({
  serverSeq: positiveSafeInteger,
  operation: textOperationSchema,
});

export const snapshotBootstrapSchema = z.object({
  version: z.literal(1),
  snapshotSeq: positiveSafeInteger,
  snapshot: z.unknown(),
});

export const syncMessageSchema = z.object({
  type: z.literal('sync'),
  documentId: boundedString(MAX_DOCUMENT_ID_LENGTH),
  operations: z.array(sequencedOperationSchema),
  latestServerSeq: nonNegativeSafeInteger,
  snapshotBootstrap: snapshotBootstrapSchema.optional(),
});

export const operationMessageSchema = z.object({
  type: z.literal('operation'),
  documentId: boundedString(MAX_DOCUMENT_ID_LENGTH),
  serverSeq: positiveSafeInteger,
  operation: textOperationSchema,
});

export const errorMessageSchema = z.object({
  type: z.literal('error'),
  code: z.string().min(1),
  message: z.string(),
});

export const presenceParticipantSchema = z.object({
  clientId: boundedString(MAX_CLIENT_ID_LENGTH),
  displayName: boundedString(MAX_DISPLAY_NAME_LENGTH),
  joinedAt: nonNegativeSafeInteger,
});

/**
 * Presence is ephemeral room state. It is never written to the operation log and
 * never participates in CRDT convergence.
 */
export const presenceMessageSchema = z.object({
  type: z.literal('presence'),
  documentId: boundedString(MAX_DOCUMENT_ID_LENGTH),
  participants: z.array(presenceParticipantSchema).max(MAX_PRESENCE_PARTICIPANTS),
});

export const serverMessageSchema = z.discriminatedUnion('type', [
  syncMessageSchema,
  operationMessageSchema,
  presenceMessageSchema,
  errorMessageSchema,
]);

export type InsertOperationWire = z.infer<typeof insertOperationSchema>;
export type DeleteOperationWire = z.infer<typeof deleteOperationSchema>;
export type TextOperationWire = z.infer<typeof textOperationSchema>;
export type JoinMessage = z.infer<typeof joinMessageSchema>;
export type SubmitOperationMessage = z.infer<typeof submitOperationMessageSchema>;
export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type SequencedOperation = z.infer<typeof sequencedOperationSchema>;
export type SnapshotBootstrap = z.infer<typeof snapshotBootstrapSchema>;
export type SyncMessage = z.infer<typeof syncMessageSchema>;
export type OperationMessage = z.infer<typeof operationMessageSchema>;
export type ErrorMessage = z.infer<typeof errorMessageSchema>;
export type PresenceParticipant = z.infer<typeof presenceParticipantSchema>;
export type PresenceMessage = z.infer<typeof presenceMessageSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;

export function hasSnapshotBootstrapCapability(
  capabilities: readonly string[] | undefined,
): boolean {
  return capabilities?.includes(SNAPSHOT_BOOTSTRAP_CAPABILITY) === true;
}

export function parseClientMessage(input: unknown): ClientMessage {
  return clientMessageSchema.parse(input);
}

export function parseServerMessage(input: unknown): ServerMessage {
  return serverMessageSchema.parse(input);
}
