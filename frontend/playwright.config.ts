import { defineConfig, devices } from '@playwright/test';

const E2E_PORT = Number(process.env.PLAYWRIGHT_PORT ?? 4173);
const E2E_BASE_URL =
  process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${E2E_PORT}`;
const USE_EXTERNAL_SERVER = Boolean(process.env.PLAYWRIGHT_BASE_URL);
const LOCAL_WORKERS = Number(process.env.PLAYWRIGHT_WORKERS ?? 1);
const IS_CI = Boolean(process.env.CI);
const EXECUTABLE_PATH = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
const SERVER_COMMAND = IS_CI
  ? `npm run preview -- --host 127.0.0.1 --port ${E2E_PORT}`
  : `npm run dev -- --host 127.0.0.1 --port ${E2E_PORT}`;

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: './e2e',
  testIgnore: '**/__tests__/**',
  timeout: 60000,
  fullyParallel: LOCAL_WORKERS > 1,
  forbidOnly: IS_CI,
  failOnFlakyTests: IS_CI,
  retries: IS_CI ? 1 : 0,
  workers: IS_CI ? 1 : LOCAL_WORKERS,
  reporter: [
    [IS_CI ? 'list' : 'line'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
  ],
  expect: {
    timeout: 10000,
  },
  use: {
    baseURL: E2E_BASE_URL,
    launchOptions: EXECUTABLE_PATH
      ? { executablePath: EXECUTABLE_PATH }
      : undefined,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: IS_CI ? 'retain-on-failure' : 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: USE_EXTERNAL_SERVER
    ? undefined
    : {
        command: SERVER_COMMAND,
        url: E2E_BASE_URL,
        reuseExistingServer: false,
        timeout: 120 * 1000,
      },
});
