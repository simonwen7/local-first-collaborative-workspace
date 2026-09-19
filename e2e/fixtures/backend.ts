import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test as base } from '@playwright/test';

export const E2E_BACKEND_HOST = '127.0.0.1';
export const E2E_BACKEND_PORT = 3011;
export const E2E_WEB_ORIGIN = 'http://127.0.0.1:4177';

const READY_URL = `http://${E2E_BACKEND_HOST}:${E2E_BACKEND_PORT}/ready`;
const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 15_000;
const PORT_RELEASE_TIMEOUT_MS = 10_000;

export class E2EBackend {
  private child: ChildProcess | undefined;
  private readonly logChunks: string[] = [];
  private exitCode: number | null = null;

  constructor(
    readonly tempDir: string,
    readonly sqlitePath: string,
  ) {}

  isRunning(): boolean {
    return this.child !== undefined && this.exitCode === null;
  }

  getLogs(): string {
    return this.logChunks.join('');
  }

  async start(): Promise<void> {
    if (this.isRunning()) {
      return;
    }

    this.exitCode = null;
    const serverJs = path.join(process.cwd(), 'apps/server/dist/index.js');
    const child = spawn(process.execPath, [serverJs], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOST: E2E_BACKEND_HOST,
        PORT: String(E2E_BACKEND_PORT),
        SQLITE_PATH: this.sqlitePath,
        LOG_LEVEL: 'warn',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.child = child;
    const onData = (chunk: Buffer): void => {
      this.logChunks.push(chunk.toString());
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('exit', (code) => {
      this.exitCode = code;
      if (this.child === child) {
        this.child = undefined;
      }
    });

    const started = Date.now();

    while (Date.now() - started < START_TIMEOUT_MS) {
      if (this.exitCode !== null) {
        throw new Error(
          `Backend exited during startup with code ${this.exitCode}.\n${this.getLogs()}`,
        );
      }

      try {
        const response = await fetch(READY_URL);

        if (response.ok) {
          return;
        }
      } catch {
        // The process has not bound the port yet.
      }

      await delay(50);
    }

    throw new Error(
      `Backend did not become ready within ${START_TIMEOUT_MS}ms.\n${this.getLogs()}`,
    );
  }

  async stop(): Promise<void> {
    const child = this.child;

    if (!child || this.exitCode !== null) {
      this.child = undefined;
      await waitForPortFree(E2E_BACKEND_PORT, PORT_RELEASE_TIMEOUT_MS);
      return;
    }

    const exited = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => {
        resolve(code);
      });
    });

    child.kill('SIGTERM');

    const code = await Promise.race([
      exited,
      delay(STOP_TIMEOUT_MS).then(() => 'timeout' as const),
    ]);

    if (code === 'timeout') {
      child.kill('SIGKILL');
      await exited;
      this.child = undefined;
      throw new Error(`Backend did not exit after SIGTERM.\n${this.getLogs()}`);
    }

    this.child = undefined;
    this.exitCode = code;

    if (code !== 0) {
      throw new Error(`Backend exited with code ${code} after SIGTERM.\n${this.getLogs()}`);
    }

    await waitForPortFree(E2E_BACKEND_PORT, PORT_RELEASE_TIMEOUT_MS);
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async cleanup(): Promise<void> {
    await rm(this.tempDir, { recursive: true, force: true });
  }
}

export async function createE2EBackend(): Promise<E2EBackend> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'lfcw-e2e-'));
  const sqlitePath = path.join(tempDir, 'lfcw.sqlite');
  return new E2EBackend(tempDir, sqlitePath);
}

export const test = base.extend<{ backend: E2EBackend }>({
  backend: [
    async ({ playwright }, use, testInfo) => {
      void playwright;
      const backend = await createE2EBackend();
      let stopError: unknown;

      try {
        await backend.start();
        await use(backend);
      } finally {
        const failed = testInfo.status !== testInfo.expectedStatus;

        if (failed) {
          const body = backend.getLogs() || '(no backend logs captured)';
          const logFile = testInfo.outputPath('backend.log');
          await writeFile(logFile, body);
          await testInfo.attach('backend-logs', {
            body,
            contentType: 'text/plain',
          });
        }

        try {
          await backend.stop();
        } catch (error) {
          stopError = error;
        }

        await backend.cleanup();
      }

      if (stopError && testInfo.status === testInfo.expectedStatus) {
        throw stopError;
      }
    },
    { auto: true },
  ],
  page: async ({ context, backend }, use, testInfo) => {
    void backend;
    const page = await context.newPage();
    const diagnostics: string[] = [];

    page.on('pageerror', (error) => {
      diagnostics.push(`pageerror: ${error.stack ?? error.message}`);
    });
    page.on('console', (message) => {
      if (message.type() === 'error') {
        diagnostics.push(`console.error: ${message.text()}`);
      }
    });

    try {
      await use(page);
    } finally {
      if (testInfo.status !== testInfo.expectedStatus && diagnostics.length > 0) {
        await testInfo.attach('page-diagnostics', {
          body: diagnostics.join('\n'),
          contentType: 'text/plain',
        });
      }
    }
  },
});

export { expect } from '@playwright/test';

function waitForPortFree(port: number, timeoutMs: number): Promise<void> {
  const started = Date.now();

  const attempt = async (): Promise<void> => {
    if (await isPortFree(port)) {
      return;
    }

    if (Date.now() - started >= timeoutMs) {
      throw new Error(`Port ${port} was still in use after ${timeoutMs}ms.`);
    }

    await delay(50);
    return attempt();
  };

  return attempt();
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: E2E_BACKEND_HOST, port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      resolve(true);
    });
  });
}
