import Fastify from 'fastify';

const app = Fastify({
  logger: true,
});

app.get('/health', async () => ({
  status: 'ok',
}));

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? '127.0.0.1';

try {
  await app.listen({
    port,
    host,
  });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
