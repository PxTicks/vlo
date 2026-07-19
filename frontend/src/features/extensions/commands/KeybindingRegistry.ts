/**
 * The keybinding registry is shell infrastructure (extension-shell-surfaces
 * plan §3.10); this module remains as a re-export for existing imports.
 */
export {
  HostKeybindingRegistry,
  hostKeybindingRegistry,
  parseChord,
  type ParsedChord,
  type RegisteredKeybinding,
} from "../../../core/shell/keybindingRegistry";
