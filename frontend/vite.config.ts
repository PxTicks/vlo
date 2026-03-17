/// <reference types="vitest/config" />
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

interface PackageManifest {
  version?: string;
}

const frontendRoot = dirname(fileURLToPath(import.meta.url));
const rootPackageJsonPath = resolve(frontendRoot, "../package.json");
const rootPackageJson = JSON.parse(
  readFileSync(rootPackageJsonPath, "utf-8"),
) as PackageManifest;
const vloAppVersion = rootPackageJson.version ?? "0.0.0";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const backendTarget = "http://127.0.0.1:6332";

  const hmrProtocol = env.VITE_HMR_PROTOCOL?.trim();
  const hmrClientPortRaw = env.VITE_HMR_CLIENT_PORT?.trim();
  const hmrClientPort = hmrClientPortRaw ? Number(hmrClientPortRaw) : undefined;
  const hasValidHmrClientPort =
    typeof hmrClientPort === "number" && Number.isFinite(hmrClientPort);

  const hmrConfig =
    hmrProtocol || hasValidHmrClientPort
      ? {
          ...(hmrProtocol ? { protocol: hmrProtocol as "ws" | "wss" } : {}),
          ...(hasValidHmrClientPort ? { clientPort: hmrClientPort } : {}),
        }
      : undefined;

  // Backend now owns all ComfyUI UI/API/WS passthrough routes.
  const proxiedBackendPaths = [
    "/app",
    "/sam2",
    "/comfyui-frame",
    "/comfy",
    "/scripts",
    "/extensions",
    "/api",
    "/prompt",
    "/queue",
    "/view",
    "/upload",
    "/object_info",
    "/embeddings",
    "/system_stats",
    "/history",
    "/internal",
    "/ws",
  ];

  const proxy = Object.fromEntries(
    proxiedBackendPaths.map((path) => [
      path,
      {
        target: backendTarget,
        ws: true,
      },
    ]),
  );

  return {
    plugins: [react()],
    base: "/",
    define: {
      "import.meta.env.VITE_APP_VERSION": JSON.stringify(vloAppVersion),
    },

    server: {
      host: "0.0.0.0",
      port: 5173,
      strictPort: true,
      allowedHosts: true,
      ...(hmrConfig ? { hmr: hmrConfig } : {}),
      proxy,
      watch: {
        ignored: ["**/.vloproject/**"],
      },
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            "vendor-react": ["react", "react-dom", "zustand"],
            "vendor-mui": [
              "@mui/material",
              "@mui/icons-material",
              "@emotion/react",
              "@emotion/styled",
            ],
            "vendor-pixi": ["pixi.js", "pixi-viewport", "pixi-filters"],
            "vendor-editor": [
              "@revideo/player-react",
              "react-moveable",
              "selecto",
            ],
          },
        },
      },
    },
    test: {
      globals: true,
      environment: "jsdom",
      setupFiles: "./src/setupTests.ts",
      exclude: ["node_modules", "dist", "e2e/**/*"],
    },
  };
});
