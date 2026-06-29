import * as pixi from "pixi.js";
import * as react from "react";
import type { ExtensionHostRuntimeApi } from "../types";

/**
 * Trusted extensions receive the application's exact singleton modules. This
 * avoids duplicate React dispatchers and Pixi class identities while leaving
 * the full module namespaces available to version-coupled extension code.
 */
export const extensionHostRuntimeApi: ExtensionHostRuntimeApi = Object.freeze({
  pixi: pixi as unknown as ExtensionHostRuntimeApi["pixi"],
  react: react as unknown as ExtensionHostRuntimeApi["react"],
});
