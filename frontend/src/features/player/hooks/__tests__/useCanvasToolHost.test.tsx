import { fireEvent, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canvasToolHost } from "../../../../core/shell/canvasToolHost";
import { useEditorFocusStore } from "../../../editorFocus";
import { useCanvasToolHost } from "../useCanvasToolHost";

describe("useCanvasToolHost", () => {
  afterEach(() => {
    canvasToolHost.deactivate();
    useEditorFocusStore.getState().setRegion(null);
  });

  it("only lets canvas-owned Escape deactivate a tool and still bubbles it", () => {
    const binding = canvasToolHost.attachHost({
      session: {
        overlay: {},
        targetClipId: "clip-1",
        projectToScreen: (point) => point,
        screenToProject: (point) => point,
        requestRender: vi.fn(),
      },
      clearOverlay: vi.fn(),
      setCursor: vi.fn(),
      setExtensionToolActive: vi.fn(),
    });
    const tool = canvasToolHost.register({
      id: "test.escape/brush",
      localId: "brush",
      ownerId: "test.escape",
      commandId: "test.escape/canvas-tool.brush",
      definition: {
        id: "brush",
        apiVersion: 1,
        label: "Brush",
        activate: vi.fn(),
        deactivate: vi.fn(),
        onPointer: vi.fn(),
      },
      reportError: vi.fn(),
    });
    canvasToolHost.activate("test.escape/brush");
    const view = renderHook(() =>
      useCanvasToolHost(null, null, {
        captureTargetClipId: () => null,
        clearSelection: vi.fn(),
      }),
    );
    const bubbled = vi.fn();
    document.addEventListener("keydown", bubbled);

    try {
      useEditorFocusStore.getState().setRegion(null);
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(canvasToolHost.getActiveId()).toBe("test.escape/brush");

      useEditorFocusStore.getState().setRegion("canvas");
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(canvasToolHost.getActiveId()).toBeNull();
      expect(bubbled).toHaveBeenCalledTimes(2);
    } finally {
      document.removeEventListener("keydown", bubbled);
      view.unmount();
      tool.dispose();
      binding.dispose();
    }
  });
});
