import { useEffect, type ReactNode } from "react";
import {
  frontendExtensionRuntime,
  type FrontendExtensionStartSummary,
} from "../services/FrontendExtensionRuntime";
import { useCommandKeybindings } from "../commands/useCommandKeybindings";

interface FrontendExtensionRuntimeStarter {
  start(): Promise<FrontendExtensionStartSummary>;
}

interface FrontendExtensionBootstrapProps {
  children: ReactNode;
  runtime?: FrontendExtensionRuntimeStarter;
}

export function FrontendExtensionBootstrap({
  children,
  runtime = frontendExtensionRuntime,
}: FrontendExtensionBootstrapProps) {
  useCommandKeybindings();
  useEffect(() => {
    let mounted = true;
    void runtime
      .start()
      .then((summary) => {
        if (!mounted) return;
        if (!summary.inventoryLoaded) {
          console.error(
            "[Extensions] Frontend inventory could not be loaded; no extensions were activated.",
            summary.inventoryError,
          );
        }
      })
      .catch((error: unknown) => {
        if (mounted) {
          console.error(
            "[Extensions] Unexpected frontend bootstrap failure; continuing without extensions.",
            error,
          );
        }
      });

    return () => {
      mounted = false;
    };
  }, [runtime]);

  return children;
}
