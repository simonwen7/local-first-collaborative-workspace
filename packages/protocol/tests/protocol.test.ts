import { describe, expect, it } from 'vitest';
import { parseClientMessage, parseServerMessage, textOperationSchema } from '../src/index.js';

const validInsert = {
  kind: 'insert',
  opId: 'client-a:1',
  clientId: 'client-a',
  counter: 1,
  lamport: 1,
  afterId: 'ROOT',
  value: 'A',
} as const;

const validDelete = {
  kind: 'delete',
  opId: 'client-a:2',
  clientId: 'client-a',
  counter: 2,
  lamport: 2,
  targetId: 'client-a:1',
} as const;

describe('parseClientMessage', () => {
  it('accepts a valid join message', () => {
    expect(
      parseClientMessage({
        type: 'join',
        documentId: 'local-default-document',
        clientId: 'client-a',
      }),
    ).toEqual({
      type: 'join',
      documentId: 'local-default-document',
      clientId: 'client-a',
    });
  });

  it('accepts a valid insert submit-operation message', () => {
    expect(
      parseClientMessage({
        type: 'submit-operation',
        documentId: 'local-default-document',
        operation: validInsert,
      }),
    ).toEqual({
      type: 'submit-operation',
      documentId: 'local-default-document',
      operation: validInsert,
    });
  });

  it('accepts a valid delete submit-operation message', () => {
    expect(
      parseClientMessage({
        type: 'submit-operation',
        documentId: 'local-default-document',
        operation: validDelete,
      }),
    ).toEqual({
      type: 'submit-operation',
      documentId: 'local-default-document',
      operation: validDelete,
    });
  });

  it('rejects a malformed operation', () => {
    expect(() =>
      parseClientMessage({
        type: 'submit-operation',
        documentId: 'local-default-document',
        operation: {
          ...validInsert,
          value: '',
        },
      }),
    ).toThrow();

    expect(() =>
      parseClientMessage({
        type: 'submit-operation',
        documentId: 'local-default-document',
        operation: {
          kind: 'insert',
          opId: 'client-a:1',
        },
      }),
    ).toThrow();

    expect(textOperationSchema.safeParse({ ...validInsert, kind: 'move' }).success).toBe(false);
  });

  it('rejects invalid positive integer fields', () => {
    expect(() =>
      parseClientMessage({
        type: 'submit-operation',
        documentId: 'doc',
        operation: {
          ...validInsert,
          counter: 0,
        },
      }),
    ).toThrow();

    expect(() =>
      parseClientMessage({
        type: 'submit-operation',
        documentId: 'doc',
        operation: {
          ...validInsert,
          lamport: -1,
        },
      }),
    ).toThrow();

    expect(() =>
      parseClientMessage({
        type: 'submit-operation',
        documentId: 'doc',
        operation: {
          ...validInsert,
          counter: 1.5,
        },
      }),
    ).toThrow();
  });
});

describe('parseServerMessage', () => {
  it('accepts a valid sync message', () => {
    expect(
      parseServerMessage({
        type: 'sync',
        documentId: 'local-default-document',
        operations: [
          {
            serverSeq: 1,
            operation: validInsert,
          },
        ],
        latestServerSeq: 1,
      }),
    ).toEqual({
      type: 'sync',
      documentId: 'local-default-document',
      operations: [
        {
          serverSeq: 1,
          operation: validInsert,
        },
      ],
      latestServerSeq: 1,
    });

    expect(
      parseServerMessage({
        type: 'sync',
        documentId: 'local-default-document',
        operations: [],
        latestServerSeq: 0,
      }),
    ).toMatchObject({
      type: 'sync',
      operations: [],
      latestServerSeq: 0,
    });
  });

  it('rejects a malformed server message', () => {
    expect(() =>
      parseServerMessage({
        type: 'sync',
        documentId: 'doc',
        operations: 'not-an-array',
        latestServerSeq: 0,
      }),
    ).toThrow();

    expect(() =>
      parseServerMessage({
        type: 'operation',
        documentId: 'doc',
        serverSeq: 0,
        operation: validInsert,
      }),
    ).toThrow();

    expect(() =>
      parseServerMessage({
        type: 'unknown',
        code: 'x',
        message: 'nope',
      }),
    ).toThrow();
  });
});
