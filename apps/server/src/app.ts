import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_DATABASE_PATH, OperationStore } from './operation-store.js';
import { attachSyncServer, type SyncServer } from './sync-server.js';

export interface CreateAppOptions {
  readonly databasePath?: string;
  readonly logger?: boolean;
}

export interface CreatedApp {
  readonly app: FastifyInstance;
  readonly store: OperationStore;
}

export async function createApp(options: CreateAppOptions = {}): Promise<CreatedApp> {
  const store = new OperationStore(options.databasePath ?? DEFAULT_DATABASE_PATH);
  const app = Fastify({
    logger: options.logger ?? false,
  });
  const syncServer: SyncServer = attachSyncServer(app, store);

  app.get('/health', async () => ({
    status: 'ok',
  }));

  app.addHook('onClose', async () => {
    await syncServer.close();
    store.close();
  });

  return {
    app,
    store,
  };
}
