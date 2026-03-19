import { defineConfig, devices } from '@playwright/test';

const E2E_PORT = Number(process.env.PLAYWRIGHT_PORT ?? 4173);
const E2E_BASE_URL =
  process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${E2E_PORT}`;
const USE_EXTERNAL_SERVER = Boolean(process.env.PLAYWRIGHT_BASE_URL);
const LOCAL_WORKERS = Number(process.env.PLAYWRIGHT_WORKERS ?? 1);

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: './e2e',
  /* Global timeout per test. */
  timeout: 60000,
  /* Local runs default to serial for stability; override with PLAYWRIGHT_WORKERS. */
  fullyParallel: LOCAL_WORKERS > 1,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Keep CI serial; local defaults to 1 worker unless overridden. */
  workers: process.env.CI ? 1 : LOCAL_WORKERS,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: 'html',
  /* Default expect timeout for async assertions (e.g. toBeVisible). */
  expect: {
    timeout: 10000,
  },
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL: E2E_BASE_URL,

    /* Capture screenshot on failure for debugging. */
    screenshot: 'only-on-failure',

    /* Retain trace on failure for post-mortem debugging. */
    trace: 'retain-on-failure',
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    // Uncomment these to enable more browsers
    // {
    //   name: 'firefox',
    //   use: { ...devices['Desktop Firefox'] },
    // },
    // {
    //   name: 'webkit',
    //   use: { ...devices['Desktop Safari'] },
    // },
  ],

  /* Run your local dev server before starting the tests */
  webServer: USE_EXTERNAL_SERVER
    ? undefined
    : {
        command: `npm run dev -- --host 127.0.0.1 --port ${E2E_PORT}`,
        url: E2E_BASE_URL,
        // Force a dedicated clean E2E server so regular dev sessions do not interfere.
        reuseExistingServer: false,
        timeout: 120 * 1000,
      },
});
