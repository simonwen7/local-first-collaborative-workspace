import { parseServerConfig } from './config.js';
import { createApp } from './app.js';
import { createGracefulShutdown } from './shutdown.js';

let config;

try {
  config = parseServerConfig();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`startup_failed: ${message}\n`);
  process.exit(1);
}

let created;

try {
  created = await createApp({
    logger: { level: config.logLevel },
    config,
    databasePath: config.sqlitePath,
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`startup_failed: ${message}\n`);
  process.exit(1);
}

const { app } = created;

const lifecycle = {
  host: config.host,
  port: config.port,
  sqlitePath: config.sqlitePath,
};

app.log.info(lifecycle, 'server_starting');

try {
  await app.listen({
    port: config.port,
    host: config.host,
  });
  app.log.info(lifecycle, 'server_listening');
} catch (error) {
  app.log.error({ err: error, ...lifecycle }, 'startup_failed');
  process.exit(1);
}

const graceful = createGracefulShutdown({
  close: () => app.close(),
  timeoutMs: config.shutdownTimeoutMs,
  logger: {
    info(fields, message) {
      app.log.info(fields, message);
    },
    error(fields, message) {
      app.log.error(fields, message);
    },
  },
  exit: (code) => {
    process.exit(code);
  },
});

const onSignal = (signal: string): void => {
  void graceful.shutdown(signal);
};

process.on('SIGINT', () => {
  onSignal('SIGINT');
});
process.on('SIGTERM', () => {
  onSignal('SIGTERM');
});
