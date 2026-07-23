#!/usr/bin/env node
/**
 * Asserts that E2E-only affordances are absent from a release bundle.
 *
 * The export probe is acceptable production *source* precisely because it is
 * not production *surface*: it sits behind a build-time-constant branch and a
 * dynamic import, so a build without VITE_E2E_DIAGNOSTICS should tree-shake it
 * away. "Should" is not evidence, and a refactor that turns the gate into a
 * runtime check would silently ship a work-performing backdoor. This script is
 * the evidence.
 *
 * Run it against a bundle built WITHOUT VITE_E2E_DIAGNOSTICS:
 *
 *   npm run build && npm run verify:bundle
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(frontendRoot, "dist");

/** Markers that must never appear in a release bundle. */
const FORBIDDEN = [
  "runSelectionExportProbe",
  "selection export probe:",
  "runCompositeParityProbe",
  "composite parity probe:",
  "acceptLiveCompositeFrame",
  "rejectLiveCompositeFrame",
  "__PLAYBACK_CLOCK__",
  "__PLAYBACK_FRAME_CLOCK__",
];

function collectFiles(dir) {
  const entries = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      entries.push(...collectFiles(path));
    } else if (/\.(js|mjs|cjs|css|html)$/.test(name)) {
      entries.push(path);
    }
  }
  return entries;
}

let distFiles;
try {
  distFiles = collectFiles(distDir);
} catch {
  console.error(
    `verify:bundle — no build found at ${distDir}. Run \`npm run build\` first.`,
  );
  process.exit(1);
}

if (distFiles.length === 0) {
  console.error(`verify:bundle — ${distDir} contains no bundle output.`);
  process.exit(1);
}

const violations = [];
for (const file of distFiles) {
  const contents = readFileSync(file, "utf8");
  for (const marker of FORBIDDEN) {
    if (contents.includes(marker)) {
      violations.push(`${file.slice(frontendRoot.length + 1)} contains "${marker}"`);
    }
  }
}

if (violations.length > 0) {
  console.error(
    [
      "verify:bundle — E2E-only code leaked into the production bundle:",
      "",
      ...violations.map((violation) => `  - ${violation}`),
      "",
      "The export probe must stay behind the build-time VITE_E2E_DIAGNOSTICS",
      "constant so Rollup can drop it. A runtime gate is not sufficient.",
    ].join("\n"),
  );
  process.exit(1);
}

console.log(
  `verify:bundle — clean. Checked ${distFiles.length} files for ${FORBIDDEN.length} markers.`,
);
