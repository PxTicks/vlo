import type { CustomControlComponent } from "./types";

const customControls = new Map<string, CustomControlComponent>();

export function registerCustomControl(
  componentId: string,
  component: CustomControlComponent,
): () => void {
  if (!componentId.trim()) {
    throw new Error("Custom control component id must not be empty.");
  }
  customControls.set(componentId, component);
  return () => {
    if (customControls.get(componentId) === component) {
      customControls.delete(componentId);
    }
  };
}

export function getCustomControl(
  componentId: string | undefined,
): CustomControlComponent | undefined {
  return componentId ? customControls.get(componentId) : undefined;
}
