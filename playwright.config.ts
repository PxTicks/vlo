/**
 * Guard config — there are no Playwright tests at the repository root.
 *
 * The real config is `frontend/playwright.config.ts`. Without this file,
 * running Playwright from the root finds no config, falls back to defaults and
 * scans the whole repository for `*.test.ts` / `*.spec.ts` — several hundred
 * Vitest files, including `extension-fixtures/`. Playwright then loads each one
 * as a spec, every `import ... from "vitest"` throws "Vitest failed to access
 * its internal state", and the run drowns in errors that look like a broken
 * test suite rather than a wrong working directory.
 *
 * Throwing here turns that into one actionable message.
 */
throw new Error(
  [
    "",
    "No Playwright tests live at the repository root.",
    "",
    "The e2e suite is configured in frontend/playwright.config.ts. Either run",
    "the delegating scripts from the root:",
    "",
    "    npm run test:e2e         # chromium suite",
    "    npm run test:e2e:smoke   # push-time gate",
    "    npm run test:e2e:media   # browser-media lane (nightly)",
    "    npm run test:e2e:full    # both projects, as nightly CI runs them",
    "",
    "or change into the frontend workspace first:",
    "",
    "    cd frontend && npx playwright test --project=chromium",
    "",
    "Prefer the npm scripts: a bare `npx playwright test` runs every project,",
    "which silently includes the expensive nightly-only media lane.",
    "",
  ].join("\n"),
);

export default {};
