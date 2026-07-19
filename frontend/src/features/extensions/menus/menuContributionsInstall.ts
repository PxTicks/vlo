import {
  installMenuContributions,
  type MenuContributionsHook,
} from "../../../core/shell/menuContributions";
import type { HostMenuSubject } from "../../../core/shell/hostMenus";
import type { ExtensionUiMenuItemContext } from "../types";
import { useExtensionMenuItems } from "../ui/useExtensionMenuItems";

// Compile-time pin (§3.10 review finding 2): the SDK context union is the
// compatibility projection of the wave-1 host menus — every slot it names
// must be catalogued, and the shell subject for each must satisfy the union.
type StaticAssert<T extends true> = T;
type _SdkUnionIsWave1Projection = StaticAssert<
  HostMenuSubject<
    ExtensionUiMenuItemContext["slot"]
  > extends ExtensionUiMenuItemContext
    ? true
    : false
>;

/**
 * The extensions half of the §3.10 split: the shell menu renderer pulls
 * contributed items through this hook, which resolves owner-scoped menu-item
 * registrations with per-item error isolation. Subjects reaching this hook
 * already passed the menu's catalogued schema.
 */
const useExtensionMenuContributions: MenuContributionsHook = (
  menuId,
  subject,
) => useExtensionMenuItems(menuId, subject as ExtensionUiMenuItemContext);

/**
 * Installs the extension contribution source into the shell menu renderer.
 * Idempotent, but the shell seam latches on first menu render — call this at
 * the application composition root (`main.tsx`, beside the extension
 * bootstrap), never from a side-effect import (§3.10 review finding 1).
 */
export function installExtensionMenuContributions(): void {
  installMenuContributions(useExtensionMenuContributions);
}
