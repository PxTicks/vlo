/**
 * The menu host mount is shell infrastructure (extension-shell-surfaces plan
 * §3.10); this module remains as a re-export for existing imports. The
 * extension contributions source is installed explicitly at the composition
 * root (`installExtensionMenuContributions` in `main.tsx`), not here.
 */
export { MenuHostMount } from "../../../core/shell/MenuHostMount";
