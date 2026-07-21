import { describe, expect, it } from "vitest";
import { hostViewRegistry } from "../../../core/shell/viewRegistry";

const HOST_VIEW_IDS = [
  "host.assets",
  "host.text",
  "host.composite",
  "host.effects-library",
  "host.transitions-library",
  "host.generate",
  "host.transition",
  "host.adjust",
  "host.effects",
  "host.mask",
] as const;

describe("editor host view declarations", () => {
  it(
    "loads the production view modules with callable components",
    async () => {
      // Keep this test free of feature mocks: the component bindings must survive
      // the same feature-barrel initialization order used by the real editor.
      await import("../EditorLeftSidebar");
      await import("../RightSidebarPanel");

      for (const id of HOST_VIEW_IDS) {
        expect(hostViewRegistry.get(id)?.component, id).toEqual(
          expect.any(Function),
        );
      }
    },
    20_000,
  );
});
