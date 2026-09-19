export interface ShutdownLogger {
  info(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface GracefulShutdownOptions {
  readonly close: () => Promise<void>;
  readonly timeoutMs: number;
  readonly logger: ShutdownLogger;
  readonly exit?: (code: number) => void;
  readonly delay?: (ms: number) => Promise<void>;
}

export interface GracefulShutdown {
  shutdown(reason: string): Promise<void>;
}

export function createGracefulShutdown(options: GracefulShutdownOptions): GracefulShutdown {
  let inFlight: Promise<void> | undefined;

  const delay = options.delay ?? defaultDelay;

  const shutdown = (reason: string): Promise<void> => {
    if (inFlight) {
      return inFlight;
    }

    inFlight = runShutdown(reason);
    return inFlight;
  };

  const runShutdown = async (reason: string): Promise<void> => {
    options.logger.info({ reason }, 'shutdown_started');

    let completed = false;
    const closed = options.close().then(() => {
      completed = true;
    });

    await Promise.race([closed, delay(options.timeoutMs)]);

    if (!completed) {
      options.logger.error({ reason, timeoutMs: options.timeoutMs }, 'shutdown_timeout');
      options.exit?.(1);
      return;
    }

    options.logger.info({ reason }, 'shutdown_complete');
    options.exit?.(0);
  };

  return { shutdown };
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
