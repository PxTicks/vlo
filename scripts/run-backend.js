#!/usr/bin/env node

const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");

const rootDir = join(__dirname, "..");
const backendDir = join(rootDir, "backend");
const pythonBin =
  process.platform === "win32"
    ? join(backendDir, ".venv", "Scripts", "python.exe")
    : join(backendDir, ".venv", "bin", "python");

if (!existsSync(pythonBin)) {
  console.error(
    "Backend environment missing. Run ./install.sh or install.bat first.",
  );
  process.exit(1);
}

const child = spawn(
  pythonBin,
  ["-m", "uvicorn", "main:app", "--port", "6332", ...process.argv.slice(2)],
  {
    cwd: backendDir,
    stdio: "inherit",
  },
);

child.on("error", (error) => {
  console.error(`Failed to start backend: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
