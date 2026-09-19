import { describe, expect, it } from 'vitest';
import {
  MAX_CAPABILITIES,
  MAX_CAPABILITY_LENGTH,
  MAX_CLIENT_ID_LENGTH,
  MAX_DOCUMENT_ID_LENGTH,
  MAX_ELEMENT_ID_LENGTH,
  MAX_OPERATION_ID_LENGTH,
  MAX_OPERATION_VALUE_LENGTH,
  SNAPSHOT_BOOTSTRAP_CAPABILITY,
  parseClientMessage,
  parseServerMessage,
  textOperationSchema,
} from '../src/index.js';

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
        lastServerSeq: 0,
      }),
    ).toEqual({
      type: 'join',
      documentId: 'local-default-document',
      clientId: 'client-a',
      lastServerSeq: 0,
    });
  });

  it('accepts a join message with a positive lastServerSeq', () => {
    expect(
      parseClientMessage({
        type: 'join',
        documentId: 'local-default-document',
        clientId: 'client-a',
        lastServerSeq: 12,
      }),
    ).toMatchObject({
      type: 'join',
      lastServerSeq: 12,
    });
  });

  it('rejects a negative or unsafe lastServerSeq', () => {
    expect(() =>
      parseClientMessage({
        type: 'join',
        documentId: 'local-default-document',
        clientId: 'client-a',
        lastServerSeq: -1,
      }),
    ).toThrow();

    expect(() =>
      parseClientMessage({
        type: 'join',
        documentId: 'local-default-document',
        clientId: 'client-a',
        lastServerSeq: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow();
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

  it('accepts string fields at their documented max length and rejects max + 1', () => {
    const documentId = 'd'.repeat(MAX_DOCUMENT_ID_LENGTH);
    const clientId = 'c'.repeat(MAX_CLIENT_ID_LENGTH);
    const opId = 'o'.repeat(MAX_OPERATION_ID_LENGTH);
    const afterId = 'e'.repeat(MAX_ELEMENT_ID_LENGTH);
    const value = 'v'.repeat(MAX_OPERATION_VALUE_LENGTH);

    expect(
      parseClientMessage({
        type: 'join',
        documentId,
        clientId,
        lastServerSeq: 0,
      }),
    ).toMatchObject({ documentId, clientId });

    expect(
      parseClientMessage({
        type: 'submit-operation',
        documentId,
        operation: {
          ...validInsert,
          opId,
          clientId,
          afterId,
          value,
        },
      }),
    ).toMatchObject({
      operation: { opId, clientId, afterId, value },
    });

    expect(
      parseClientMessage({
        type: 'submit-operation',
        documentId,
        operation: {
          kind: 'delete',
          opId,
          clientId,
          counter: 2,
          lamport: 2,
          targetId: afterId,
        },
      }),
    ).toMatchObject({
      operation: { targetId: afterId },
    });

    expect(() =>
      parseClientMessage({
        type: 'join',
        documentId: `${documentId}x`,
        clientId,
        lastServerSeq: 0,
      }),
    ).toThrow();

    expect(() =>
      parseClientMessage({
        type: 'join',
        documentId,
        clientId: `${clientId}x`,
        lastServerSeq: 0,
      }),
    ).toThrow();

    expect(() =>
      parseClientMessage({
        type: 'submit-operation',
        documentId,
        operation: { ...validInsert, opId: `${opId}x` },
      }),
    ).toThrow();

    expect(() =>
      parseClientMessage({
        type: 'submit-operation',
        documentId,
        operation: { ...validInsert, afterId: `${afterId}x` },
      }),
    ).toThrow();

    expect(() =>
      parseClientMessage({
        type: 'submit-operation',
        documentId,
        operation: { ...validInsert, value: `${value}x` },
      }),
    ).toThrow();

    expect(() =>
      parseClientMessage({
        type: 'submit-operation',
        documentId,
        operation: {
          kind: 'delete',
          opId: validDelete.opId,
          clientId: validDelete.clientId,
          counter: 2,
          lamport: 2,
          targetId: `${afterId}x`,
        },
      }),
    ).toThrow();
  });

  it('still accepts local-default-document and UUID document ids', () => {
    expect(
      parseClientMessage({
        type: 'join',
        documentId: 'local-default-document',
        clientId: '11111111-2222-4333-8444-555555555555',
        lastServerSeq: 0,
      }).documentId,
    ).toBe('local-default-document');

    expect(
      parseClientMessage({
        type: 'join',
        documentId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        clientId: 'client-a',
        lastServerSeq: 0,
      }).documentId,
    ).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  });

  it('accepts join without capabilities and with snapshot-bootstrap-v1', () => {
    expect(
      parseClientMessage({
        type: 'join',
        documentId: 'local-default-document',
        clientId: 'client-a',
        lastServerSeq: 0,
      }),
    ).not.toHaveProperty('capabilities');

    expect(
      parseClientMessage({
        type: 'join',
        documentId: 'local-default-document',
        clientId: 'client-a',
        lastServerSeq: 0,
        capabilities: [SNAPSHOT_BOOTSTRAP_CAPABILITY],
      }).capabilities,
    ).toEqual([SNAPSHOT_BOOTSTRAP_CAPABILITY]);
  });

  it('rejects an oversized capabilities collection or capability string', () => {
    expect(() =>
      parseClientMessage({
        type: 'join',
        documentId: 'local-default-document',
        clientId: 'client-a',
        lastServerSeq: 0,
        capabilities: Array.from({ length: MAX_CAPABILITIES + 1 }, (_, index) => `cap-${index}`),
      }),
    ).toThrow();

    expect(() =>
      parseClientMessage({
        type: 'join',
        documentId: 'local-default-document',
        clientId: 'client-a',
        lastServerSeq: 0,
        capabilities: ['c'.repeat(MAX_CAPABILITY_LENGTH + 1)],
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

  it('accepts sync with an optional snapshotBootstrap envelope', () => {
    expect(
      parseServerMessage({
        type: 'sync',
        documentId: 'local-default-document',
        operations: [],
        latestServerSeq: 4,
        snapshotBootstrap: {
          version: 1,
          snapshotSeq: 4,
          snapshot: { version: 1, nodes: [], deleteOperations: [] },
        },
      }),
    ).toMatchObject({
      snapshotBootstrap: {
        version: 1,
        snapshotSeq: 4,
      },
    });
  });

  it('rejects an invalid snapshotBootstrap version or sequence', () => {
    expect(() =>
      parseServerMessage({
        type: 'sync',
        documentId: 'doc',
        operations: [],
        latestServerSeq: 1,
        snapshotBootstrap: {
          version: 2,
          snapshotSeq: 1,
          snapshot: {},
        },
      }),
    ).toThrow();

    expect(() =>
      parseServerMessage({
        type: 'sync',
        documentId: 'doc',
        operations: [],
        latestServerSeq: 1,
        snapshotBootstrap: {
          version: 1,
          snapshotSeq: 0,
          snapshot: {},
        },
      }),
    ).toThrow();
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
