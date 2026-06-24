import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const coveragePath = resolve(frontendRoot, "coverage/coverage-final.json");
const skipFeatureFloors = process.argv.includes("--skip-feature-floors");

const FINAL_FEATURE_FLOORS = {
  statements: 80,
  lines: 80,
  functions: 80,
  branches: 65,
};

function percentage(covered, total) {
  return total === 0 ? 100 : (covered / total) * 100;
}

function lineCounts(fileCoverage) {
  const lines = new Map();
  for (const [statementId, count] of Object.entries(fileCoverage.s)) {
    const line = fileCoverage.statementMap[statementId].start.line;
    lines.set(line, (lines.get(line) ?? 0) + count);
  }
  return [...lines.values()];
}

function metricCounts(fileCoverage) {
  const statements = Object.values(fileCoverage.s);
  const functions = Object.values(fileCoverage.f);
  const branches = Object.values(fileCoverage.b).flat();
  const lines = lineCounts(fileCoverage);
  return {
    statements: [statements.filter((count) => count > 0).length, statements.length],
    lines: [lines.filter((count) => count > 0).length, lines.length],
    functions: [functions.filter((count) => count > 0).length, functions.length],
    branches: [branches.filter((count) => count > 0).length, branches.length],
  };
}

function addCounts(target, source) {
  for (const metric of Object.keys(target)) {
    target[metric][0] += source[metric][0];
    target[metric][1] += source[metric][1];
  }
}

function emptyCounts() {
  return {
    statements: [0, 0],
    lines: [0, 0],
    functions: [0, 0],
    branches: [0, 0],
  };
}

const coverage = JSON.parse(await readFile(coveragePath, "utf8"));
const zeroCoverageFiles = [];
const featureTotals = new Map();

for (const [absolutePath, fileCoverage] of Object.entries(coverage)) {
  const counts = metricCounts(fileCoverage);
  const projectPath = relative(frontendRoot, absolutePath).split(sep).join("/");
  if (counts.statements[1] > 0 && counts.statements[0] === 0) {
    zeroCoverageFiles.push(projectPath);
  }

  const match = projectPath.match(/^src\/features\/([^/]+)\//);
  if (!match) continue;
  const featureName = match[1];
  const totals = featureTotals.get(featureName) ?? emptyCounts();
  addCounts(totals, counts);
  featureTotals.set(featureName, totals);
}

const failures = [];
if (zeroCoverageFiles.length > 0) {
  failures.push(
    `Executable production files at 0% statement coverage:\n${zeroCoverageFiles
      .sort()
      .map((file) => `  - ${file}`)
      .join("\n")}`,
  );
}

if (!skipFeatureFloors) {
  for (const [featureName, totals] of [...featureTotals].sort()) {
    for (const [metric, floor] of Object.entries(FINAL_FEATURE_FLOORS)) {
      const [covered, total] = totals[metric];
      const actual = percentage(covered, total);
      if (total > 0 && actual < floor) {
        failures.push(
          `Feature "${featureName}" ${metric} coverage is ${actual.toFixed(
            2,
          )}%, below ${floor}%`,
        );
      }
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n\n"));
  process.exitCode = 1;
} else {
  console.log(
    skipFeatureFloors
      ? "Coverage verification passed: no executable production file is at 0%."
      : "Coverage verification passed: zero-file and feature-floor gates satisfied.",
  );
}
