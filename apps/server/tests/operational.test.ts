import { afterEach, describe, expect, it } from 'vitest';
import { ROOT_ID, createInsertOperation } from '@lfcw/crdt';
import type { OperationMessage, SyncMessage } from '@lfcw/protocol';
import WebSocket from 'ws';
import { createApp } from '../src/app.js';
import type { CreatedApp, CreateAppOptions } from '../src/app.js';
import { DEFAULT_SERVER_CONFIG, type ServerConfig } from '../src/config.js';
import type { SyncServerLogger } from '../src/sync-server.js';

const documentId = 'local-default-document';

const insertA = createInsertOperation({
  clientId: 'client-a',
  counter: 1,
  lamport: 1,
  afterId: ROOT_ID,
  value: 'A',
});

interface RunningServer {
  readonly created: CreatedApp;
  readonly port: number;
}

async function startServer(
  options: CreateAppOptions = {},
  configOverrides: Partial<ServerConfig> = {},
): Promise<RunningServer> {
  const created = await createApp({
    databasePath: ':memory:',
    config: {
      ...DEFAULT_SERVER_CONFIG,
      sqlitePath: ':memory:',
      ...configOverrides,
    },
    ...options,
  });

  await created.app.listen({
    host: '127.0.0.1',
    port: 0,
  });

  const address = created.app.server.address();

  if (typeof address !== 'object' || address === null) {
    throw new Error('Expected a TCP listen address.');
  }

  return {
    created,
    port: address.port,
  };
}

async function openClient(
  port: number,
  socketOptions: { origin?: string; autoPong?: boolean } = {},
): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/sync`, socketOptions);
  socket.on('error', () => undefined);
  await waitForOpen(socket);
  return socket;
}

async function joinDocument(socket: WebSocket, clientId: string): Promise<SyncMessage> {
  const sync = waitForMessage<SyncMessage>(socket, (message) => message.type === 'sync');

  socket.send(
    JSON.stringify({
      type: 'join',
      documentId,
      clientId,
      lastServerSeq: 0,
    }),
  );

  return sync;
}

function waitForOpen(socket: WebSocket, timeoutMs = 2000): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timed out waiting for WebSocket open.'));
    }, timeoutMs);

    socket.once('open', () => {
      clearTimeout(timer);
      resolve();
    });

    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function waitForMessage<T extends { type: string }>(
  socket: WebSocket,
  predicate: (message: T) => boolean,
  timeoutMs = 2000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error('Timed out waiting for an expected WebSocket message.'));
    }, timeoutMs);

    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as T;

      if (!predicate(message)) {
        return;
      }

      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(message);
    };

    socket.on('message', onMessage);
  });
}

function waitForClose(socket: WebSocket, timeoutMs = 2000): Promise<number> {
  if (socket.readyState === WebSocket.CLOSED) {
    return Promise.resolve(1006);
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timed out waiting for WebSocket close.'));
    }, timeoutMs);

    socket.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return;
  }

  await new Promise<void>((resolve) => {
    socket.once('close', () => {
      resolve();
    });
    socket.close();
  });
}

function parseMetric(body: string, name: string): number {
  const line = body.split('\n').find((entry) => entry.startsWith(`${name} `));

  if (!line) {
    throw new Error(`Missing metric ${name}`);
  }

  return Number(line.slice(name.length + 1));
}

function capturingLogger(): { logger: SyncServerLogger; events: string[] } {
  const events: string[] = [];
  const push = (_fields: Record<string, unknown>, message: string) => {
    events.push(message);
  };

  return {
    events,
    logger: {
      info: push,
      warn: push,
      error: push,
      debug: push,
    },
  };
}

describe('operational HTTP and WebSocket hardening', () => {
  let running: RunningServer | undefined;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((socket) => closeSocket(socket)));

    if (running) {
      await running.created.app.close();
      running = undefined;
    }
  });

  it('serves liveness, readiness, and Prometheus metrics', async () => {
    running = await startServer();

    const health = await fetch(`http://127.0.0.1:${running.port}/health`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ status: 'ok' });

    const ready = await fetch(`http://127.0.0.1:${running.port}/ready`);
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toEqual({ status: 'ready' });

    const metricsResponse = await fetch(`http://127.0.0.1:${running.port}/metrics`);
    expect(metricsResponse.status).toBe(200);
    expect(metricsResponse.headers.get('content-type')).toMatch(/text\/plain/);
    expect(metricsResponse.headers.get('content-type')).toMatch(/version=0\.0\.4/);

    const body = await metricsResponse.text();
    expect(body).toContain('lfcw_ws_connections');
    expect(body).toContain('lfcw_active_rooms');
    expect(body).toContain('lfcw_join_total');
    expect(body).toContain('lfcw_sync_total');
    expect(body).toContain('lfcw_sync_operations_sent_total');
    expect(body).toContain('lfcw_submit_operations_total');
    expect(body).toContain('lfcw_inserted_operations_total');
    expect(body).toContain('lfcw_duplicate_operations_total');
    expect(body).toContain('lfcw_identity_conflicts_total');
    expect(body).toContain('lfcw_protocol_errors_total');
    expect(body).toContain('lfcw_internal_errors_total');
    expect(body).toContain('lfcw_sync_query_duration_ms_total');
    expect(body).toContain('lfcw_sync_query_duration_count');
    expect(body).toContain('lfcw_append_operation_duration_ms_total');
    expect(body).toContain('lfcw_append_operation_duration_count');
  });

  it('returns 503 from /ready without leaking SQLite details after the store closes', async () => {
    running = await startServer();
    running.created.store.close();

    const ready = await fetch(`http://127.0.0.1:${running.port}/ready`);
    expect(ready.status).toBe(503);
    const body = await ready.json();
    expect(body).toEqual({ status: 'not_ready' });
    expect(JSON.stringify(body)).not.toMatch(/sqlite|SQLITE|better-sqlite/i);
  });

  it('updates selected counters and gauges after a join and insert', async () => {
    running = await startServer();
    const client = await openClient(running.port);
    sockets.push(client);

    await joinDocument(client, 'client-a');
    const accepted = waitForMessage<OperationMessage>(
      client,
      (message) => message.type === 'operation' && message.operation.opId === insertA.opId,
    );
    client.send(
      JSON.stringify({
        type: 'submit-operation',
        documentId,
        operation: insertA,
      }),
    );
    await accepted;

    const body = await (await fetch(`http://127.0.0.1:${running.port}/metrics`)).text();
    expect(parseMetric(body, 'lfcw_ws_connections')).toBe(1);
    expect(parseMetric(body, 'lfcw_ws_connections_total')).toBe(1);
    expect(parseMetric(body, 'lfcw_active_rooms')).toBe(1);
    expect(parseMetric(body, 'lfcw_join_total')).toBe(1);
    expect(parseMetric(body, 'lfcw_sync_total')).toBe(1);
    expect(parseMetric(body, 'lfcw_submit_operations_total')).toBe(1);
    expect(parseMetric(body, 'lfcw_inserted_operations_total')).toBe(1);
    expect(parseMetric(body, 'lfcw_sync_query_duration_count')).toBe(1);
    expect(parseMetric(body, 'lfcw_append_operation_duration_count')).toBe(1);
    expect(parseMetric(body, 'lfcw_sync_query_duration_ms_total')).toBeGreaterThanOrEqual(0);
    expect(parseMetric(body, 'lfcw_append_operation_duration_ms_total')).toBeGreaterThanOrEqual(0);
  });

  it('allows a configured Origin and a missing Origin when the allowlist is set', async () => {
    running = await startServer({}, { wsAllowedOrigins: ['https://workspace.example.com'] });

    const allowed = await openClient(running.port, { origin: 'https://workspace.example.com' });
    sockets.push(allowed);
    expect(allowed.readyState).toBe(WebSocket.OPEN);

    const nodeClient = await openClient(running.port);
    sockets.push(nodeClient);
    expect(nodeClient.readyState).toBe(WebSocket.OPEN);
  });

  it('does not filter Origins when the allowlist is empty', async () => {
    running = await startServer();
    const anyOrigin = await openClient(running.port, { origin: 'https://evil.example' });
    sockets.push(anyOrigin);
    expect(anyOrigin.readyState).toBe(WebSocket.OPEN);
  });

  it('rejects a browser Origin that is not on the allowlist before upgrade', async () => {
    running = await startServer({}, { wsAllowedOrigins: ['https://workspace.example.com'] });

    const status = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${running!.port}/sync`, {
        origin: 'https://evil.example',
      });
      const timer = setTimeout(() => {
        reject(new Error('Timed out waiting for origin rejection.'));
      }, 2000);

      socket.on('error', () => undefined);
      socket.on('unexpected-response', (_request, response) => {
        clearTimeout(timer);
        const code = response.statusCode ?? 0;
        response.resume();
        socket.terminate();
        resolve(code);
      });
      socket.on('open', () => {
        clearTimeout(timer);
        socket.close();
        reject(new Error('Origin-mismatched client should not upgrade.'));
      });
    });

    expect(status).toBe(403);
  });

  it('closes an inbound frame that exceeds maxPayload', async () => {
    running = await startServer({}, { wsMaxPayloadBytes: 1024 });
    const client = await openClient(running.port);
    sockets.push(client);

    const closed = waitForClose(client);
    client.send(Buffer.alloc(2048));
    expect(await closed).toBe(1009);
  });

  it('terminates a dead socket and keeps a ponging socket alive', async () => {
    running = await startServer({}, { wsHeartbeatIntervalMs: 40 });

    const live = await openClient(running.port);
    const dead = await openClient(running.port, { autoPong: false });
    sockets.push(live, dead);

    await new Promise((resolve) => {
      setTimeout(resolve, 220);
    });

    expect(live.readyState).toBe(WebSocket.OPEN);
    expect(dead.readyState).toBe(WebSocket.CLOSED);
  });

  it('emits structured lifecycle event names without operation payloads', async () => {
    const { logger, events } = capturingLogger();
    running = await startServer({ syncLogger: logger });
    const client = await openClient(running.port);
    sockets.push(client);
    await joinDocument(client, 'client-a');

    expect(events).toContain('ws_connected');
    expect(events).toContain('ws_joined');
    expect(events).toContain('ws_sync_sent');
    expect(JSON.stringify(events)).not.toContain(insertA.value);
  });

  it('closes Fastify with an active joined WebSocket without deadlock', async () => {
    running = await startServer();
    const client = await openClient(running.port);
    sockets.push(client);
    await joinDocument(client, 'client-a');

    client.send(
      JSON.stringify({
        type: 'submit-operation',
        documentId,
        operation: insertA,
      }),
    );
    await waitForMessage<OperationMessage>(
      client,
      (message) => message.type === 'operation' && message.operation.opId === insertA.opId,
    );

    expect(client.readyState).toBe(WebSocket.OPEN);
    expect(running.created.metrics.snapshot().wsConnections).toBe(1);
    expect(running.created.metrics.snapshot().activeRooms).toBe(1);

    const closed = waitForClose(client, 1500);
    const started = Date.now();
    await running.created.app.close();
    const elapsedMs = Date.now() - started;
    const closeCode = await closed;

    expect(elapsedMs).toBeLessThan(1500);
    expect(closeCode).toBe(1001);
    expect(client.readyState).toBe(WebSocket.CLOSED);
    expect(running.created.metrics.snapshot().wsConnections).toBe(0);
    expect(running.created.metrics.snapshot().activeRooms).toBe(0);
    expect(running.created.app.server.listening).toBe(false);

    await running.created.app.close();
  });
});
