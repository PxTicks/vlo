// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useExtractStore } from "../useExtractStore";

describe("useExtractStore", () => {
  beforeEach(() => {
    const { result } = renderHook(() => useExtractStore());
    act(() => {
      result.current.closeDialog();
      result.current.exitFrameSelectionMode();
      result.current.setOnConfirmSelection(null);
      result.current.setIsProcessing(false);
      result.current.setProgress(0);
    });
  });

  describe("Dialog state", () => {
    it("initializes with dialog closed", () => {
      const { result } = renderHook(() => useExtractStore());

      expect(result.current.dialogOpen).toBe(false);
      expect(result.current.dialogView).toBe("choose");
    });

    it("opens dialog with choose view", () => {
      const { result } = renderHook(() => useExtractStore());

      act(() => {
        result.current.openDialog();
      });

      expect(result.current.dialogOpen).toBe(true);
      expect(result.current.dialogView).toBe("choose");
    });

    it("closes dialog and resets processing state", () => {
      const { result } = renderHook(() => useExtractStore());

      act(() => {
        result.current.openDialog();
        result.current.setDialogView("export");
        result.current.setIsProcessing(true);
        result.current.setProgress(50);
      });

      act(() => {
        result.current.closeDialog();
      });

      expect(result.current.dialogOpen).toBe(false);
      expect(result.current.dialogView).toBe("choose");
      expect(result.current.isProcessing).toBe(false);
      expect(result.current.progress).toBe(0);
    });
  });

  describe("Frame selection mode", () => {
    it("initializes with frame selection mode off", () => {
      const { result } = renderHook(() => useExtractStore());

      expect(result.current.frameSelectionMode).toBe(false);
    });

    it("toggles frame selection mode", () => {
      const { result } = renderHook(() => useExtractStore());

      act(() => {
        result.current.enterFrameSelectionMode();
      });
      expect(result.current.frameSelectionMode).toBe(true);

      act(() => {
        result.current.exitFrameSelectionMode();
      });
      expect(result.current.frameSelectionMode).toBe(false);
    });
  });

  describe("Confirm selection callback", () => {
    it("initializes with null callback", () => {
      const { result } = renderHook(() => useExtractStore());

      expect(result.current.onConfirmSelection).toBeNull();
    });

    it("sets and invokes the callback", () => {
      const { result } = renderHook(() => useExtractStore());
      const callback = vi.fn();

      act(() => {
        result.current.setOnConfirmSelection(callback);
      });

      act(() => {
        result.current.onConfirmSelection?.();
      });

      expect(callback).toHaveBeenCalledTimes(1);
    });
  });

  describe("Processing state", () => {
    it("updates processing flags", () => {
      const { result } = renderHook(() => useExtractStore());

      act(() => {
        result.current.setIsProcessing(true);
        result.current.setProgress(75);
      });

      expect(result.current.isProcessing).toBe(true);
      expect(result.current.progress).toBe(75);
    });
  });
});
