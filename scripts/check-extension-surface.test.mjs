import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import { classify, report } from "./check-extension-surface.mjs";

test("classifies every extension surface category and preserves public overrides", async () => {
  const groups = await classify([
    "packages/extension-sdk/src/index.ts",
    "backend/services/extensions/__init__.py",
    "frontend/src/features/extensions/index.ts",
    "frontend/src/features/renderer/services/TrackRenderEngine.ts",
    "extension-template/manifest.json",
    "extension-fixtures/tracking/manifest.json",
    "docs/extension-system-plan.md",
  ]);

  assert.deepEqual(
    [...groups.keys()].sort(),
    ["adapter", "authoring", "fixture", "governance", "host", "public"],
  );
  assert.deepEqual(
    groups.get("public"),
    [
      "packages/extension-sdk/src/index.ts",
      "backend/services/extensions/__init__.py",
    ],
  );
});

test("reports an unclassified diff as having no contract impact", async () => {
  const groups = await classify(["README.md"]);
  assert.equal(groups.size, 0);
});

test("emits GitHub outputs and a step summary without failing", async () => {
  const directory = await mkdtemp(`${tmpdir()}/extension-surface-`);
  const outputPath = `${directory}/output.txt`;
  const summaryPath = `${directory}/summary.md`;
  const previousOutput = process.env.GITHUB_OUTPUT;
  const previousSummary = process.env.GITHUB_STEP_SUMMARY;
  try {
    process.env.GITHUB_OUTPUT = outputPath;
    process.env.GITHUB_STEP_SUMMARY = summaryPath;
    const groups = await classify(["packages/extension-sdk/src/index.ts"]);
    report(groups, true, () => undefined);

    assert.match(await readFile(outputPath, "utf8"), /touched=true/);
    assert.match(await readFile(outputPath, "utf8"), /categories=public/);
    assert.match(await readFile(summaryPath, "utf8"), /### public/);
  } finally {
    if (previousOutput === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = previousOutput;
    if (previousSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = previousSummary;
    await rm(directory, { recursive: true, force: true });
  }
});
