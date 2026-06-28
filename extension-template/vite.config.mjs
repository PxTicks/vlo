import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATE_ROOT = dirname(fileURLToPath(import.meta.url));

const HOST_SINGLETON_PACKAGES = Object.freeze([
  "react",
  "react-dom",
  "react-reconciler",
  "@mui",
  "@emotion",
  "zustand",
  "pixi.js",
  "@pixi",
  "pixi-viewport",
  "pixi-filters",
  "@revideo/player-react",
]);

function isPackageImport(source, packageName) {
  return source === packageName || source.startsWith(`${packageName}/`);
}

function extensionBundleGuard() {
  return {
    name: "vlo-extension-bundle-guard",
    enforce: "pre",
    resolveId(source, importer) {
      if (
        importer &&
        HOST_SINGLETON_PACKAGES.some((packageName) =>
          isPackageImport(source, packageName),
        )
      ) {
        throw new Error(
          `Host singleton '${source}' cannot be imported by SDK 1 extensions. ` +
            "Use only the type-only @vlo/extension-sdk contract until the host " +
            "provides a versioned runtime module mapping.",
        );
      }
      return null;
    },
    generateBundle(_outputOptions, bundle) {
      const emittedFiles = new Set(Object.keys(bundle));
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        for (const imported of [...output.imports, ...output.dynamicImports]) {
          const emittedImport = imported.startsWith(".")
            ? posix.normalize(
                posix.join(posix.dirname(output.fileName), imported),
              )
            : imported;
          if (!emittedFiles.has(emittedImport)) {
            throw new Error(
              `Extension bundle contains unresolved runtime import '${imported}'.`,
            );
          }
        }
      }
    },
  };
}

export function createExtensionBuildConfig(root = TEMPLATE_ROOT) {
  return {
    root,
    plugins: [extensionBundleGuard()],
    build: {
      target: "es2022",
      outDir: resolve(root, "frontend/dist"),
      emptyOutDir: true,
      lib: {
        entry: resolve(root, "frontend/src/index.ts"),
        formats: ["es"],
      },
      rollupOptions: {
        output: {
          entryFileNames: "index.js",
          chunkFileNames: "assets/[name]-[hash].js",
          assetFileNames: "assets/[name]-[hash][extname]",
        },
      },
    },
  };
}

export default createExtensionBuildConfig();
