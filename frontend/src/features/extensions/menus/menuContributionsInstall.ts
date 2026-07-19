import { installMenuContributions } from "../../../core/shell/menuContributions";
import { useExtensionMenuPlacements } from "./useExtensionMenuPlacements";

/**
 * Installs the extension contribution source into the shell menu renderer.
 * Idempotent, but the shell seam latches on first menu render — call this at
 * the application composition root (`main.tsx`, beside the extension
 * bootstrap), never from a side-effect import (§3.10 review finding 1).
 */
export function installExtensionMenuContributions(): void {
  installMenuContributions(useExtensionMenuPlacements);
}
