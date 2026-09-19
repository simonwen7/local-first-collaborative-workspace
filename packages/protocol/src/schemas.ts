import { z } from 'zod';

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
  opId: z.string(),
  clientId: z.string(),
  counter: positiveSafeInteger,
  lamport: positiveSafeInteger,
  afterId: z.string(),
  value: z.string().min(1),
});

export const deleteOperationSchema = z.object({
  kind: z.literal('delete'),
  opId: z.string(),
  clientId: z.string(),
  counter: positiveSafeInteger,
  lamport: positiveSafeInteger,
  targetId: z.string(),
});

export const textOperationSchema = z.discriminatedUnion('kind', [
  insertOperationSchema,
  deleteOperationSchema,
]);

export const joinMessageSchema = z.object({
  type: z.literal('join'),
  documentId: z.string().min(1),
  clientId: z.string().min(1),
});

export const submitOperationMessageSchema = z.object({
  type: z.literal('submit-operation'),
  documentId: z.string().min(1),
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

export const syncMessageSchema = z.object({
  type: z.literal('sync'),
  documentId: z.string().min(1),
  operations: z.array(sequencedOperationSchema),
  latestServerSeq: nonNegativeSafeInteger,
});

export const operationMessageSchema = z.object({
  type: z.literal('operation'),
  documentId: z.string().min(1),
  serverSeq: positiveSafeInteger,
  operation: textOperationSchema,
});

export const errorMessageSchema = z.object({
  type: z.literal('error'),
  code: z.string().min(1),
  message: z.string(),
});

export const serverMessageSchema = z.discriminatedUnion('type', [
  syncMessageSchema,
  operationMessageSchema,
  errorMessageSchema,
]);

export type InsertOperationWire = z.infer<typeof insertOperationSchema>;
export type DeleteOperationWire = z.infer<typeof deleteOperationSchema>;
export type TextOperationWire = z.infer<typeof textOperationSchema>;
export type JoinMessage = z.infer<typeof joinMessageSchema>;
export type SubmitOperationMessage = z.infer<typeof submitOperationMessageSchema>;
export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type SequencedOperation = z.infer<typeof sequencedOperationSchema>;
export type SyncMessage = z.infer<typeof syncMessageSchema>;
export type OperationMessage = z.infer<typeof operationMessageSchema>;
export type ErrorMessage = z.infer<typeof errorMessageSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;

export function parseClientMessage(input: unknown): ClientMessage {
  return clientMessageSchema.parse(input);
}

export function parseServerMessage(input: unknown): ServerMessage {
  return serverMessageSchema.parse(input);
}
