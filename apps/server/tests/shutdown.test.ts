import { describe, expect, it } from 'vitest';
import { createGracefulShutdown, type ShutdownLogger } from '../src/shutdown.js';

function capturingLogger(): { logger: ShutdownLogger; events: string[] } {
  const events: string[] = [];
  return {
    events,
    logger: {
      info(_fields, message) {
        events.push(message);
      },
      error(_fields, message) {
        events.push(message);
      },
    },
  };
}

describe('createGracefulShutdown', () => {
  it('invokes close once and completes successfully', async () => {
    let closes = 0;
    const { logger, events } = capturingLogger();
    let exitCode: number | undefined;
    const shutdown = createGracefulShutdown({
      close: async () => {
        closes += 1;
      },
      timeoutMs: 1000,
      logger,
      exit: (code) => {
        exitCode = code;
      },
    });

    await shutdown.shutdown('SIGTERM');

    expect(closes).toBe(1);
    expect(exitCode).toBe(0);
    expect(events).toEqual(['shutdown_started', 'shutdown_complete']);
  });

  it('is idempotent when shutdown is requested repeatedly', async () => {
    let closes = 0;
    let resumeClose: (() => void) | undefined;
    const { logger } = capturingLogger();
    const shutdown = createGracefulShutdown({
      close: () =>
        new Promise<void>((resolve) => {
          closes += 1;
          resumeClose = resolve;
        }),
      timeoutMs: 10_000,
      logger,
      delay: () => new Promise(() => undefined),
      exit: () => undefined,
    });

    const first = shutdown.shutdown('SIGINT');
    const second = shutdown.shutdown('SIGTERM');
    expect(first).toBe(second);

    resumeClose?.();
    await Promise.all([first, second]);
    expect(closes).toBe(1);
  });

  it('takes the timeout path without waiting the production timeout', async () => {
    const { logger, events } = capturingLogger();
    let exitCode: number | undefined;
    let resolveClose: (() => void) | undefined;
    const shutdown = createGracefulShutdown({
      close: () =>
        new Promise<void>((resolve) => {
          resolveClose = resolve;
        }),
      timeoutMs: 10_000,
      logger,
      delay: async () => undefined,
      exit: (code) => {
        exitCode = code;
      },
    });

    await shutdown.shutdown('SIGTERM');
    expect(exitCode).toBe(1);
    expect(events).toEqual(['shutdown_started', 'shutdown_timeout']);
    resolveClose?.();
  });
});
