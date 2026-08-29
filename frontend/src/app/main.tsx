import React from "react";
import ReactDOM from "react-dom/client";
import {
  FrontendExtensionBootstrap,
  installExtensionMenuContributions,
} from "../features/extensions";
import { warmRuntimeCapabilities } from "../features/runtimeCapabilities";
import { App } from "./App";
import { installE2EDiagnostics } from "./installE2EDiagnostics";
import { installHostOptionCatalogues } from "./installHostOptionCatalogues";
import "./index.css";

// Polyfill for explicit resource management
// @ts-expect-error - mixed support
Symbol.dispose ??= Symbol("Symbol.dispose");
// @ts-expect-error - mixed support
Symbol.asyncDispose ??= Symbol("Symbol.asyncDispose");

// Shell menus pull extension items through a seam that latches on first
// render; install the source before anything renders (plan §3.10 finding 1).
installExtensionMenuContributions();
installHostOptionCatalogues();
installE2EDiagnostics();
// Runtime capabilities are read once here, in the background, so features that
// depend on one (SAM-Audio, SAM2, Beat This!) open onto their own controls
// rather than onto a "checking the runtime" progress bar.
warmRuntimeCapabilities();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <FrontendExtensionBootstrap>
      <App />
    </FrontendExtensionBootstrap>
  </React.StrictMode>,
);
