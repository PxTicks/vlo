/**
 * The host menu catalogue. Every menu rendered through `AppMenu` declares its
 * ID here (one line per menu), which is what makes it a valid target for
 * extension `ui.registerMenuItem` contributions. Menu IDs are contract once
 * shipped: they become registration targets and documentation references, so
 * rename them with the same care as SDK types.
 */
export const HOST_MENU_IDS = [
  "timeline.clip.context",
  "library.item.actions",
] as const;

export type HostMenuId = (typeof HOST_MENU_IDS)[number];
