import type { IncomingMessage } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { WebSocket, WebSocketServer } from 'ws';
import {
  InvalidOperationError,
  OperationIdentityConflictError,
  validateOperation,
} from '@lfcw/crdt';
import type { TextOperation } from '@lfcw/crdt';
import {
  parseClientMessage,
  type ErrorMessage,
  type OperationMessage,
  type SyncMessage,
} from '@lfcw/protocol';
import type { OperationStore } from './operation-store.js';

interface SocketSession {
  documentId?: string;
  clientId?: string;
}

export interface SyncServer {
  close(): Promise<void>;
}

export function attachSyncServer(app: FastifyInstance, store: OperationStore): SyncServer {
  const wss = new WebSocketServer({
    noServer: true,
  });
  const sessions = new Map<WebSocket, SocketSession>();
  const rooms = new Map<string, Set<WebSocket>>();

  const onUpgrade = (
    request: IncomingMessage,
    socket: import('node:stream').Duplex,
    head: Buffer,
  ) => {
    const pathname = request.url ? new URL(request.url, 'http://127.0.0.1').pathname : '';

    if (pathname !== '/sync') {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  };

  app.server.on('upgrade', onUpgrade);

  wss.on('connection', (socket) => {
    sessions.set(socket, {});

    socket.on('message', (raw) => {
      handleMessage(socket, raw);
    });

    socket.on('close', () => {
      leaveRoom(socket);
      sessions.delete(socket);
    });
  });

  const handleMessage = (socket: WebSocket, raw: WebSocket.RawData) => {
    let parsed: unknown;

    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      sendError(socket, 'PROTOCOL_ERROR', 'Message must be valid JSON.');
      return;
    }

    let message;

    try {
      message = parseClientMessage(parsed);
    } catch {
      sendError(socket, 'PROTOCOL_ERROR', 'Malformed client message.');
      return;
    }

    const session = sessions.get(socket);

    if (!session) {
      return;
    }

    try {
      if (session.documentId === undefined || session.clientId === undefined) {
        if (message.type !== 'join') {
          sendError(
            socket,
            'NOT_JOINED',
            'A join message is required before submitting operations.',
          );
          return;
        }

        joinSocket(socket, session, message.documentId, message.clientId, message.lastServerSeq);
        return;
      }

      if (message.type === 'join') {
        sendError(socket, 'ALREADY_JOINED', 'This connection has already joined a document.');
        return;
      }

      if (message.documentId !== session.documentId) {
        sendError(
          socket,
          'DOCUMENT_MISMATCH',
          'Operation documentId does not match the joined document.',
        );
        return;
      }

      if (message.operation.clientId !== session.clientId) {
        sendError(
          socket,
          'CLIENT_MISMATCH',
          'Operation clientId does not match the joined client.',
        );
        return;
      }

      acceptOperation(socket, session.documentId, message.operation);
    } catch (error) {
      sendCaughtError(socket, error);
    }
  };

  const joinSocket = (
    socket: WebSocket,
    session: SocketSession,
    documentId: string,
    clientId: string,
    lastServerSeq: number,
  ) => {
    const currentLatest = store.getLatestServerSeq(documentId);

    if (lastServerSeq > currentLatest) {
      sendError(
        socket,
        'sync-cursor-ahead',
        'Client lastServerSeq is ahead of server document history.',
      );
      return;
    }

    session.documentId = documentId;
    session.clientId = clientId;

    let room = rooms.get(documentId);

    if (!room) {
      room = new Set();
      rooms.set(documentId, room);
    }

    room.add(socket);

    const barrier = store.getLatestServerSeq(documentId);
    const operations = store.loadOperationsAfter(documentId, lastServerSeq, barrier);
    const syncMessage: SyncMessage = {
      type: 'sync',
      documentId,
      operations,
      latestServerSeq: barrier,
    };

    sendJson(socket, syncMessage);
  };

  const acceptOperation = (socket: WebSocket, documentId: string, operation: TextOperation) => {
    validateOperation(operation);

    const result = store.appendOperation(documentId, operation);
    const outbound: OperationMessage = {
      type: 'operation',
      documentId,
      serverSeq: result.serverSeq,
      operation,
    };

    if (!result.inserted) {
      sendJson(socket, outbound);
      return;
    }

    broadcast(documentId, outbound);
  };

  const broadcast = (documentId: string, message: OperationMessage) => {
    const room = rooms.get(documentId);

    if (!room) {
      return;
    }

    for (const peer of room) {
      if (peer.readyState === WebSocket.OPEN) {
        sendJson(peer, message);
      }
    }
  };

  const leaveRoom = (socket: WebSocket) => {
    const session = sessions.get(socket);
    const documentId = session?.documentId;

    if (!documentId) {
      return;
    }

    const room = rooms.get(documentId);

    if (!room) {
      return;
    }

    room.delete(socket);

    if (room.size === 0) {
      rooms.delete(documentId);
    }
  };

  const sendCaughtError = (socket: WebSocket, error: unknown) => {
    if (error instanceof OperationIdentityConflictError) {
      sendError(socket, 'IDENTITY_CONFLICT', error.message);
      return;
    }

    if (error instanceof InvalidOperationError) {
      sendError(socket, 'INVALID_OPERATION', error.message);
      return;
    }

    sendError(socket, 'INTERNAL_ERROR', 'The server failed to process that message.');
  };

  return {
    close: async () => {
      app.server.off('upgrade', onUpgrade);

      for (const client of wss.clients) {
        client.close();
      }

      sessions.clear();
      rooms.clear();

      await new Promise<void>((resolve, reject) => {
        wss.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
  };
}

function sendJson(socket: WebSocket, message: SyncMessage | OperationMessage | ErrorMessage): void {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify(message));
}

function sendError(socket: WebSocket, code: string, message: string): void {
  sendJson(socket, {
    type: 'error',
    code,
    message,
  });
}
