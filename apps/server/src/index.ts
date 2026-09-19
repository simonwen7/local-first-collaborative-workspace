import { createApp } from './app.js';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 3001);
const databasePath = process.env.SQLITE_PATH;

const { app } = await createApp({
  logger: true,
  ...(databasePath !== undefined && databasePath.length > 0 ? { databasePath } : {}),
});

try {
  await app.listen({
    port,
    host,
  });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
