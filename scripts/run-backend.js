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

// Outlive uvicorn's shutdown instead of dying on the first signal. If this
// wrapper exits early, npm/concurrently return the prompt while uvicorn is
// still draining, orphaned outside the terminal's foreground group: the port
// stays bound and a second Ctrl+C can no longer reach it to force quit.
const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"];

function forwardSignal(signal) {
  // Ctrl+C already reaches the child through the terminal (the process group
  // on POSIX, the shared console on Windows). Forwarding still matters when
  // the signal was sent to this process alone. Windows has no real signals:
  // child.kill() there is a hard kill that would skip graceful shutdown.
  if (process.platform !== "win32" && child.exitCode === null) {
    child.kill(signal);
  }
}

for (const signal of SHUTDOWN_SIGNALS) {
  process.on(signal, forwardSignal);
}

child.on("error", (error) => {
  console.error(`Failed to start backend: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    // Re-raise so callers see the same termination signal as the child;
    // the handlers above would otherwise swallow it.
    for (const shutdownSignal of SHUTDOWN_SIGNALS) {
      process.off(shutdownSignal, forwardSignal);
    }
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
