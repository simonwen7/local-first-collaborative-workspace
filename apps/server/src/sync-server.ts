import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
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
  hasSnapshotBootstrapCapability,
  type ErrorMessage,
  type OperationMessage,
  type SyncMessage,
} from '@lfcw/protocol';
import type { ServerConfig } from './config.js';
import type { ServerMetrics } from './observability/server-metrics.js';
import type { OperationStore } from './operation-store.js';
import type { ServerSnapshotManager } from './server-snapshot.js';

export interface SyncServerLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
  debug(fields: Record<string, unknown>, message: string): void;
}

export interface AttachSyncServerOptions {
  readonly config: ServerConfig;
  readonly metrics: ServerMetrics;
  readonly logger: SyncServerLogger;
}

interface SocketSession {
  readonly connectionId: string;
  readonly connectedAt: number;
  documentId?: string;
  clientId?: string;
}

export interface SyncServer {
  close(): Promise<void>;
}

export function attachSyncServer(
  app: FastifyInstance,
  store: OperationStore,
  options: AttachSyncServerOptions,
  snapshots: ServerSnapshotManager,
): SyncServer {
  const { config, metrics, logger } = options;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: config.wsMaxPayloadBytes,
  });
  const sessions = new Map<WebSocket, SocketSession>();
  const rooms = new Map<string, Set<WebSocket>>();
  const alive = new WeakMap<WebSocket, boolean>();

  let closing = false;
  let closeInFlight: Promise<void> | undefined;
  const heartbeatTimer = setInterval(() => {
    if (closing) {
      return;
    }

    for (const client of wss.clients) {
      if (alive.get(client) === false) {
        client.terminate();
        continue;
      }

      if (client.readyState !== WebSocket.OPEN) {
        continue;
      }

      alive.set(client, false);

      try {
        client.ping();
      } catch (error) {
        const session = sessions.get(client);
        logger.error(
          {
            err: error,
            connectionId: session?.connectionId,
            documentId: session?.documentId,
          },
          'ws_ping_failed',
        );
        metrics.recordInternalError();
        client.terminate();
      }
    }
  }, config.wsHeartbeatIntervalMs);

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (closing) {
      socket.destroy();
      return;
    }

    const pathname = request.url ? new URL(request.url, 'http://127.0.0.1').pathname : '';

    if (pathname !== '/sync') {
      socket.destroy();
      return;
    }

    if (!isOriginAllowed(request.headers.origin, config.wsAllowedOrigins)) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  };

  app.server.on('upgrade', onUpgrade);

  wss.on('connection', (socket) => {
    const session: SocketSession = {
      connectionId: crypto.randomUUID(),
      connectedAt: Date.now(),
    };

    sessions.set(socket, session);
    alive.set(socket, true);
    metrics.recordConnectionOpened();
    logger.info({ connectionId: session.connectionId }, 'ws_connected');

    socket.on('pong', () => {
      alive.set(socket, true);
    });

    socket.on('error', (error) => {
      logger.warn(
        {
          err: error,
          connectionId: session.connectionId,
          documentId: session.documentId,
          clientId: session.clientId,
        },
        'ws_socket_error',
      );
    });

    socket.on('message', (raw) => {
      handleMessage(socket, raw);
    });

    socket.on('close', (closeCode) => {
      leaveRoom(socket);
      sessions.delete(socket);
      metrics.recordConnectionClosed();
      logger.info(
        {
          connectionId: session.connectionId,
          documentId: session.documentId,
          clientId: session.clientId,
          closeCode,
          durationMs: Date.now() - session.connectedAt,
        },
        'ws_closed',
      );
    });
  });

  const handleMessage = (socket: WebSocket, raw: WebSocket.RawData) => {
    const session = sessions.get(socket);

    if (!session) {
      return;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      recordProtocolError(socket, session, 'PROTOCOL_ERROR', 'Message must be valid JSON.');
      return;
    }

    let message;

    try {
      message = parseClientMessage(parsed);
    } catch {
      recordProtocolError(socket, session, 'PROTOCOL_ERROR', 'Malformed client message.');
      return;
    }

    try {
      if (session.documentId === undefined || session.clientId === undefined) {
        if (message.type !== 'join') {
          recordProtocolError(
            socket,
            session,
            'NOT_JOINED',
            'A join message is required before submitting operations.',
          );
          return;
        }

        joinSocket(
          socket,
          session,
          message.documentId,
          message.clientId,
          message.lastServerSeq,
          hasSnapshotBootstrapCapability(message.capabilities),
        );
        return;
      }

      if (message.type === 'join') {
        recordProtocolError(
          socket,
          session,
          'ALREADY_JOINED',
          'This connection has already joined a document.',
        );
        return;
      }

      if (message.documentId !== session.documentId) {
        recordProtocolError(
          socket,
          session,
          'DOCUMENT_MISMATCH',
          'Operation documentId does not match the joined document.',
        );
        return;
      }

      if (message.operation.clientId !== session.clientId) {
        recordProtocolError(
          socket,
          session,
          'CLIENT_MISMATCH',
          'Operation clientId does not match the joined client.',
        );
        return;
      }

      acceptOperation(socket, session, message.operation);
    } catch (error) {
      sendCaughtError(socket, session, error);
    }
  };

  const joinSocket = (
    socket: WebSocket,
    session: SocketSession,
    documentId: string,
    clientId: string,
    lastServerSeq: number,
    snapshotCapable: boolean,
  ) => {
    const currentLatest = store.getLatestServerSeq(documentId);

    if (lastServerSeq > currentLatest) {
      recordProtocolError(
        socket,
        session,
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
    metrics.recordJoin();
    metrics.setActiveRooms(rooms.size);
    logger.info(
      {
        connectionId: session.connectionId,
        documentId,
        clientId,
      },
      'ws_joined',
    );

    const queryStarted = performance.now();
    const syncMessage = snapshots.buildSyncMessage(documentId, lastServerSeq, snapshotCapable);
    const durationMs = performance.now() - queryStarted;

    metrics.recordSync(syncMessage.operations.length, durationMs);
    sendJson(socket, session, syncMessage);
    logger.info(
      {
        connectionId: session.connectionId,
        documentId,
        clientId,
        serverSeq: syncMessage.latestServerSeq,
        syncOperationCount: syncMessage.operations.length,
        snapshotBootstrap: Boolean(syncMessage.snapshotBootstrap),
      },
      'ws_sync_sent',
    );
  };

  const acceptOperation = (socket: WebSocket, session: SocketSession, operation: TextOperation) => {
    const documentId = session.documentId;

    if (documentId === undefined) {
      return;
    }

    metrics.recordSubmit();
    validateOperation(operation);

    const appendStarted = performance.now();
    const result = store.appendOperation(documentId, operation);
    metrics.recordAppendDuration(performance.now() - appendStarted);

    const outbound: OperationMessage = {
      type: 'operation',
      documentId,
      serverSeq: result.serverSeq,
      operation,
    };

    if (!result.inserted) {
      metrics.recordDuplicate();
      logger.debug(
        {
          connectionId: session.connectionId,
          documentId,
          clientId: session.clientId,
          serverSeq: result.serverSeq,
        },
        'ws_operation_duplicate',
      );
      sendJson(socket, session, outbound);
      return;
    }

    metrics.recordInsert();
    logger.debug(
      {
        connectionId: session.connectionId,
        documentId,
        clientId: session.clientId,
        serverSeq: result.serverSeq,
      },
      'ws_operation_inserted',
    );
    broadcast(documentId, outbound);
  };

  const broadcast = (documentId: string, message: OperationMessage) => {
    const room = rooms.get(documentId);

    if (!room) {
      return;
    }

    for (const peer of room) {
      const peerSession = sessions.get(peer);

      if (peerSession && peer.readyState === WebSocket.OPEN) {
        sendJson(peer, peerSession, message);
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

    metrics.setActiveRooms(rooms.size);
  };

  const recordProtocolError = (
    socket: WebSocket,
    session: SocketSession,
    code: string,
    message: string,
  ) => {
    metrics.recordProtocolError();
    logger.warn(
      {
        connectionId: session.connectionId,
        documentId: session.documentId,
        clientId: session.clientId,
        code,
      },
      'ws_protocol_error',
    );
    sendError(socket, session, code, message);
  };

  const sendCaughtError = (socket: WebSocket, session: SocketSession, error: unknown) => {
    if (error instanceof OperationIdentityConflictError) {
      metrics.recordIdentityConflict();
      logger.warn(
        {
          connectionId: session.connectionId,
          documentId: session.documentId,
          clientId: session.clientId,
        },
        'ws_identity_conflict',
      );
      sendError(socket, session, 'IDENTITY_CONFLICT', error.message);
      return;
    }

    if (error instanceof InvalidOperationError) {
      recordProtocolError(socket, session, 'INVALID_OPERATION', error.message);
      return;
    }

    metrics.recordInternalError();
    logger.error(
      {
        err: error,
        connectionId: session.connectionId,
        documentId: session.documentId,
        clientId: session.clientId,
      },
      'ws_internal_error',
    );
    sendError(socket, session, 'INTERNAL_ERROR', 'The server failed to process that message.');
  };

  const sendJson = (
    socket: WebSocket,
    session: SocketSession,
    message: SyncMessage | OperationMessage | ErrorMessage,
  ): void => {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      socket.send(JSON.stringify(message));
    } catch (error) {
      metrics.recordInternalError();
      logger.error(
        {
          err: error,
          connectionId: session.connectionId,
          documentId: session.documentId,
          clientId: session.clientId,
        },
        'ws_send_failed',
      );
    }
  };

  const sendError = (
    socket: WebSocket,
    session: SocketSession,
    code: string,
    message: string,
  ): void => {
    sendJson(socket, session, {
      type: 'error',
      code,
      message,
    });
  };

  const waitUntilClosed = (client: WebSocket): Promise<void> => {
    if (client.readyState === WebSocket.CLOSED) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      client.once('close', () => {
        resolve();
      });
    });
  };

  const closeClients = async (): Promise<void> => {
    const clients = [...wss.clients];

    if (clients.length === 0) {
      return;
    }

    const closed = Promise.all(clients.map((client) => waitUntilClosed(client)));

    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        client.close(1001, 'server shutting down');
      }
    }

    await Promise.race([
      closed,
      new Promise<void>((resolve) => {
        setTimeout(resolve, 500);
      }),
    ]);

    for (const client of [...wss.clients]) {
      if (client.readyState !== WebSocket.CLOSED) {
        client.terminate();
      }
    }

    await Promise.all([...wss.clients].map((client) => waitUntilClosed(client)));
  };

  const close = async (): Promise<void> => {
    if (closeInFlight) {
      return closeInFlight;
    }

    closing = true;
    closeInFlight = (async () => {
      clearInterval(heartbeatTimer);
      app.server.off('upgrade', onUpgrade);
      await closeClients();
      sessions.clear();
      rooms.clear();
      metrics.setActiveRooms(0);

      await new Promise<void>((resolve, reject) => {
        wss.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    })();

    return closeInFlight;
  };

  return {
    close,
  };
}

export function isOriginAllowed(
  originHeader: string | string[] | undefined,
  allowedOrigins: readonly string[],
): boolean {
  if (allowedOrigins.length === 0) {
    return true;
  }

  if (originHeader === undefined) {
    return true;
  }

  if (Array.isArray(originHeader) || originHeader.length === 0) {
    return false;
  }

  return allowedOrigins.includes(originHeader);
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}
