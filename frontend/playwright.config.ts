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
 * Browser-media lane (plan §4.6).
 *
 * The Phase 4 A/V canary and Phase 5 pixel-parity canary must exercise
 * Chromium's real WebGL/Pixi, WebCodecs and Web Audio paths — as opposed to
 * jsdom, which is the claim these canaries rest on. Two supported
 * configurations:
 *
 *   - Headed (`PLAYWRIGHT_MEDIA_HEADED=1`): a real display, and real GPU
 *     drivers where the host has them. Used locally.
 *   - Software-rasterised headless (the default, and what CI uses): ANGLE over
 *     SwiftShader. `--enable-unsafe-swiftshader` is required because current
 *     Chromium otherwise refuses WebGL when no GPU is present, and silently
 *     falling back is exactly what §4.6 forbids.
 *
 * To be explicit about what the default configuration does and does not prove:
 * SwiftShader is a *software* rasteriser, not a GPU. It compiles and executes
 * real GLSL through the real WebGL entry points, so it covers the renderer
 * pipeline, shader validity and Pixi behaviour. It does not cover
 * hardware-GPU or driver-specific behaviour, so a parity bug that only appears
 * on a particular vendor's driver will not be caught here. Closing that gap
 * needs a hardware-GPU runner, which is out of scope for this lane.
 *
 * `e2e/media/fixtures.ts` verifies the resulting browser up front and throws
 * rather than skipping, so a misconfigured lane cannot report as green.
 */
const MEDIA_LANE_HEADED = process.env.PLAYWRIGHT_MEDIA_HEADED === '1';
const MEDIA_LANE_ARGS = [
  '--autoplay-policy=no-user-gesture-required',
  ...(MEDIA_LANE_HEADED
    ? []
    : [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
      ]),
];

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
  // CI opts the nightly full suite into two workers explicitly after the
  // mock-filesystem, browser-media and diagnostics lanes passed together.
  // Smoke leaves PLAYWRIGHT_WORKERS unset and remains single-worker.
  workers: LOCAL_WORKERS,
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
      // The media lane is nightly-only and needs its own launch flags; keep it
      // out of the default suite and out of smoke.
      testIgnore: ['**/__tests__/**', '**/media/**'],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'browser-media',
      testMatch: '**/media/**/*.spec.ts',
      // Media captures decode and rasterise real frames; the default 60s
      // budget is tight once a bake round trip is involved.
      timeout: 120000,
      use: {
        ...devices['Desktop Chrome'],
        headless: !MEDIA_LANE_HEADED,
        launchOptions: {
          ...(EXECUTABLE_PATH ? { executablePath: EXECUTABLE_PATH } : {}),
          args: MEDIA_LANE_ARGS,
        },
      },
    },
  ],
  webServer: USE_EXTERNAL_SERVER
    ? undefined
    : {
        command: SERVER_COMMAND,
        url: E2E_BASE_URL,
        reuseExistingServer: false,
        timeout: 120 * 1000,
        env: {
          // The callable export probe is gated strictly on this flag — not on
          // DEV — so a plain `npm run dev` never gains a work-performing
          // backdoor. The Playwright-managed dev server must therefore opt in
          // explicitly, or the media lane's offline canary finds no probe.
          // In CI this command serves an already-built bundle, where the same
          // flag was applied at build time (see playwright.yml).
          VITE_E2E_DIAGNOSTICS: 'true',
        },
      },
});
