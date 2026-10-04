/// <reference types="vitest/config" />
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

interface PackageManifest {
  version?: string;
}

const COVERAGE_THRESHOLDS = {
  baseline: {
    statements: 72,
    lines: 73,
    functions: 77,
    branches: 62,
  },
  wave1: {
    statements: 77,
    lines: 78,
    functions: 80,
    branches: 66,
  },
  wave2: {
    statements: 80,
    lines: 81,
    functions: 82,
    branches: 69,
  },
  wave3: {
    statements: 83,
    lines: 84,
    functions: 84,
    branches: 72,
  },
  final: {
    statements: 85,
    lines: 85,
    functions: 85,
    branches: 75,
  },
} as const;

type CoverageStage = keyof typeof COVERAGE_THRESHOLDS | "report";

function resolveCoverageThresholds() {
  const requestedStage = process.env.COVERAGE_STAGE as
    | CoverageStage
    | undefined;
  if (requestedStage === "report") {
    return undefined;
  }
  return COVERAGE_THRESHOLDS[requestedStage ?? "final"];
}

const frontendRoot = dirname(fileURLToPath(import.meta.url));
const rootPackageJsonPath = resolve(frontendRoot, "../package.json");
const rootPackageJson = JSON.parse(
  readFileSync(rootPackageJsonPath, "utf-8"),
) as PackageManifest;
const stableAppVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const packageAppVersion = rootPackageJson.version?.trim();
const vloAppVersion =
  packageAppVersion &&
  packageAppVersion !== "0.0.0" &&
  stableAppVersionPattern.test(packageAppVersion)
    ? packageAppVersion
    : null;

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const backendTarget = "http://127.0.0.1:6332";
  const useInlineDecoderWorker =
    env.VITE_DECODER_WORKER_INLINE?.trim() === "true";
  const decoderWorkerLoaderPath = resolve(
    frontendRoot,
    useInlineDecoderWorker
      ? "src/features/renderer/workers/decoderWorkerInlineLoader.ts"
      : "src/features/renderer/workers/decoderWorkerLoader.ts",
  );

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
    "/downloads",
    "/sam2",
    "/sam-audio",
    "/beats",
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
    resolve: {
      alias: {
        "@decoder-worker-loader": decoderWorkerLoaderPath,
      },
    },
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
      // Playwright specs stay out of Vitest, while e2e/__tests__ pins the
      // Node-side fixture harness against production persistence schemas.
      exclude: ["node_modules", "dist", "e2e/**/*.spec.ts"],
      coverage: {
        provider: "v8",
        include: ["src/**/*.{ts,tsx}"],
        exclude: [
          "src/**/*.d.ts",
          "src/**/__tests__/**",
          "src/**/*.test.{ts,tsx}",
          "src/testUtils/**",
          "src/**/generated.ts",
        ],
        reportsDirectory: "coverage",
        reporter: ["text", "html", "json", "json-summary", "lcov"],
        reportOnFailure: true,
        thresholds: resolveCoverageThresholds(),
      },
    },
  };
});
