import Fastify from 'fastify';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { DEFAULT_SERVER_CONFIG, type ServerConfig } from './config.js';
import { ServerMetrics } from './observability/server-metrics.js';
import { OperationStore } from './operation-store.js';
import { ServerSnapshotManager } from './server-snapshot.js';
import { attachSyncServer, type SyncServer, type SyncServerLogger } from './sync-server.js';

export interface CreateAppOptions {
  readonly databasePath?: string;
  readonly logger?: boolean | { readonly level: string };
  readonly config?: ServerConfig;
  readonly metrics?: ServerMetrics;
  readonly syncLogger?: SyncServerLogger;
}

export interface CreatedApp {
  readonly app: FastifyInstance;
  readonly store: OperationStore;
  readonly metrics: ServerMetrics;
  readonly config: ServerConfig;
}

export async function createApp(options: CreateAppOptions = {}): Promise<CreatedApp> {
  const config: ServerConfig = options.config ?? {
    ...DEFAULT_SERVER_CONFIG,
    sqlitePath: options.databasePath ?? DEFAULT_SERVER_CONFIG.sqlitePath,
  };
  const store = new OperationStore(options.databasePath ?? config.sqlitePath);
  const metrics = options.metrics ?? new ServerMetrics();
  const app = Fastify({
    logger: options.logger ?? false,
  });
  const syncLogger = options.syncLogger ?? asSyncLogger(app.log);
  const snapshots = new ServerSnapshotManager(store, metrics, syncLogger);
  const syncServer: SyncServer = attachSyncServer(
    app,
    store,
    {
      config,
      metrics,
      logger: syncLogger,
    },
    snapshots,
  );

  app.get('/health', async () => ({
    status: 'ok',
  }));

  app.get('/ready', async (request, reply) => {
    try {
      store.checkReady();
      return { status: 'ready' };
    } catch (error) {
      request.log.error({ err: error }, 'readiness_check_failed');
      return reply.code(503).send({ status: 'not_ready' });
    }
  });

  app.get('/metrics', async (_request, reply) => {
    return reply
      .header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
      .send(metrics.renderPrometheus());
  });

  app.addHook('preClose', async () => {
    await syncServer.close();
  });

  app.addHook('onClose', async () => {
    store.close();
  });

  return {
    app,
    store,
    metrics,
    config,
  };
}

function asSyncLogger(logger: FastifyBaseLogger): SyncServerLogger {
  return {
    info(fields, message) {
      logger.info(fields, message);
    },
    warn(fields, message) {
      logger.warn(fields, message);
    },
    error(fields, message) {
      logger.error(fields, message);
    },
    debug(fields, message) {
      logger.debug(fields, message);
    },
  };
}
