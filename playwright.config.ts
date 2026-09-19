import { defineConfig, devices } from '@playwright/test';

const WEB_ORIGIN = 'http://127.0.0.1:4177';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  forbidOnly: Boolean(process.env.CI),
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: WEB_ORIGIN,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  webServer: {
    command:
      'npm run build && npm run preview -w @lfcw/web -- --host 127.0.0.1 --port 4177 --strictPort',
    url: `${WEB_ORIGIN}/`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      ...process.env,
      VITE_SYNC_URL: 'ws://127.0.0.1:3011/sync',
    },
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
      },
    },
  ],
});
