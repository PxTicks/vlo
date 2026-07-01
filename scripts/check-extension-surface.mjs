import { appendFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const ATTRIBUTE = "extension-surface";
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const ATTRIBUTE_BATCH_SIZE = 200;
const execFileAsync = promisify(execFile);

function fail(message) {
  process.stderr.write(`Extension surface check failed: ${message}\n`);
  process.exit(1);
}

async function runGit(args) {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const detail =
      typeof error?.stderr === "string" ? error.stderr.trim() : String(error);
    fail(detail || `git ${args.join(" ")} failed`);
  }
}

async function tryGit(args) {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

function parseArguments(argv) {
  const options = {
    base: null,
    head: "HEAD",
    github: false,
    paths: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--github") {
      options.github = true;
      continue;
    }
    if (["--base", "--head", "--path"].includes(argument)) {
      const value = argv[index + 1];
      if (!value) fail(`${argument} requires a value`);
      index += 1;
      if (argument === "--path") options.paths.push(value);
      else options[argument.slice(2)] = value;
      continue;
    }
    fail(`unknown argument '${argument}'`);
  }
  return options;
}

function splitNulls(value) {
  return value.split("\0").filter(Boolean);
}

async function workingTreePaths() {
  const paths = new Set();
  for (const args of [
    ["diff", "--name-only", "-z"],
    ["diff", "--cached", "--name-only", "-z"],
    ["ls-files", "--others", "--exclude-standard", "-z"],
  ]) {
    for (const path of splitNulls(await runGit(args))) paths.add(path);
  }
  return [...paths].sort();
}

async function diffPaths(base, head) {
  let resolvedBase = /^0+$/.test(base) ? EMPTY_TREE : base;
  if (
    resolvedBase !== EMPTY_TREE &&
    (await tryGit(["cat-file", "-e", `${resolvedBase}^{commit}`])) === null
  ) {
    const parent = await tryGit(["rev-parse", "--verify", `${head}^`]);
    resolvedBase = parent?.trim() || EMPTY_TREE;
    process.stderr.write(
      `Extension surface base '${base}' is unavailable; using '${resolvedBase}'.\n`,
    );
  }
  return splitNulls(
    await runGit(["diff", "--name-only", "-z", resolvedBase, head]),
  ).sort();
}

export async function classify(paths) {
  if (paths.length === 0) return new Map();
  const output = [];
  for (let start = 0; start < paths.length; start += ATTRIBUTE_BATCH_SIZE) {
    const batch = paths.slice(start, start + ATTRIBUTE_BATCH_SIZE);
    output.push(
      ...splitNulls(
        await runGit(["check-attr", "-z", ATTRIBUTE, "--", ...batch]),
      ),
    );
  }
  const groups = new Map();
  for (let index = 0; index < output.length; index += 3) {
    const path = output[index];
    const attribute = output[index + 1];
    const category = output[index + 2];
    if (attribute !== ATTRIBUTE || category === "unspecified") continue;
    const entries = groups.get(category) ?? [];
    entries.push(path);
    groups.set(category, entries);
  }
  return groups;
}

function githubEscape(value) {
  return value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

export function report(
  groups,
  github,
  write = (value) => process.stdout.write(value),
) {
  if (groups.size === 0) {
    write("No extension contract surface files changed.\n");
    if (github && process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, "touched=false\n");
    }
    return;
  }

  const categories = [...groups.keys()].sort();
  write("Extension contract surface touched:\n");
  for (const category of categories) {
    write(`\n${category}:\n`);
    for (const path of groups.get(category)) write(`  - ${path}\n`);
  }

  if (!github) return;
  const counts = categories
    .map((category) => `${category}=${groups.get(category).length}`)
    .join(", ");
  write(
    `::warning title=Extension contract surface touched::${githubEscape(counts)}\n`,
  );
  for (const category of categories) {
    for (const path of groups.get(category)) {
      write(
        `::notice file=${githubEscape(path)},title=Extension surface (${githubEscape(category)})::Review V1 compatibility and run extension contract coverage.\n`,
      );
    }
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, "touched=true\n");
    appendFileSync(process.env.GITHUB_OUTPUT, `categories=${categories.join(",")}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [
      "## Extension contract impact",
      "",
      "The following extension-sensitive files changed:",
      "",
    ];
    for (const category of categories) {
      lines.push(`### ${category}`, "");
      for (const path of groups.get(category)) lines.push(`- \`${path}\``);
      lines.push("");
    }
    lines.push(
      "Review supported V1 behaviour and run the relevant extension contract tests.",
      "",
    );
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.base && options.paths.length > 0) {
    fail("--base and --path cannot be combined");
  }
  const paths = options.paths.length
    ? [...new Set(options.paths)].sort()
    : options.base
      ? await diffPaths(options.base, options.head)
      : await workingTreePaths();
  report(await classify(paths), options.github);
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
