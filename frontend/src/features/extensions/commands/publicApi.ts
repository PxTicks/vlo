// Command/keybinding/context-key machinery is shell-owned (plan §3.10);
// re-exports here keep existing imports stable through the deprecation
// window. The owner-scoped SDK adapter and the host wiring installers remain
// extensions-side.
export {
  createExtensionCommandApi,
  hostCommandRegistry,
  type HostCommandDefinition,
  type HostCommandTable,
} from "./CommandRegistry";
export {
  HostKeybindingRegistry,
  hostKeybindingRegistry,
  parseChord,
  type ParsedChord,
  type RegisteredKeybinding,
} from "./KeybindingRegistry";
export {
  HostContextKeyService,
  hostContextKeys,
  assertContextKeyExpression,
  evaluateContextKeyExpression,
} from "./contextKeys";
export {
  installHostContextKeyBindings,
  installTimelineContextKeys,
} from "./installHostContextKeys";
export { installHostKeybindingReservations } from "./installHostKeybindingReservations";
export { useCommandKeybindings } from "./useCommandKeybindings";
