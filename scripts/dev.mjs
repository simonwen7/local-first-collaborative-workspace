import { spawn } from 'node:child_process';

/**
 * Start the Fastify sync server and the Vite web app together so a demo
 * session cannot accidentally run the frontend against a dead backend.
 */
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const children = [];
let shuttingDown = false;

function start(script) {
  const child = spawn(npm, ['run', script], {
    stdio: 'inherit',
    env: process.env,
  });

  child.on('exit', (code, signal) => {
    if (shuttingDown) {
      return;
    }

    const reason = signal ?? code ?? 1;
    console.error(`[dev] ${script} exited (${String(reason)}). Stopping the other process.`);
    shutdown(typeof code === 'number' ? code : 1);
  });

  children.push(child);
}

function shutdown(code) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  for (const child of children) {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }

  process.exit(code);
}

process.on('SIGINT', () => {
  shutdown(0);
});
process.on('SIGTERM', () => {
  shutdown(0);
});

start('dev:server');
start('dev:web');
