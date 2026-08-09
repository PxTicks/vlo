import { Container, Rectangle } from "pixi.js";
import type { Application } from "pixi.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearActivePixiApplication,
  readActivePixiContentPixels,
  setActivePixiApplication,
  setActivePixiContentTarget,
} from "../activeApplication";
import {
  markPixiPreviewOnly,
  withoutPixiPreviewOnlyNodes,
} from "../previewOnly";

describe("preview-only Pixi nodes", () => {
  let activeApplication: Application | null = null;

  afterEach(() => {
    if (activeApplication) clearActivePixiApplication(activeApplication);
    activeApplication = null;
  });

  it("excludes nested previews only for the duration of a readback", () => {
    const content = new Container();
    const renderedChild = new Container();
    const preview = new Container();
    content.addChild(renderedChild, preview);
    markPixiPreviewOnly(preview);

    const stateDuringRead = withoutPixiPreviewOnlyNodes(content, () => ({
      renderedChild: renderedChild.renderable,
      preview: preview.renderable,
    }));

    expect(stateDuringRead).toEqual({ renderedChild: true, preview: false });
    expect(preview.renderable).toBe(true);
  });

  it("restores preview visibility when readback throws", () => {
    const content = new Container();
    const preview = new Container();
    content.addChild(preview);
    markPixiPreviewOnly(preview);

    expect(() =>
      withoutPixiPreviewOnlyNodes(content, () => {
        expect(preview.renderable).toBe(false);
        throw new Error("readback failed");
      }),
    ).toThrow("readback failed");
    expect(preview.renderable).toBe(true);
  });

  it("guards the shared active-content pixel readback", () => {
    const content = new Container();
    const preview = new Container();
    content.addChild(preview);
    markPixiPreviewOnly(preview);
    const pixels = vi.fn(() => {
      expect(preview.renderable).toBe(false);
      return { pixels: new Uint8Array([1, 2, 3, 4]), width: 1, height: 1 };
    });
    activeApplication = {
      renderer: { extract: { pixels } },
    } as unknown as Application;
    setActivePixiApplication(activeApplication);
    const frame = new Rectangle(0, 0, 1, 1);
    setActivePixiContentTarget(content, frame);

    expect(readActivePixiContentPixels(frame, 1)?.pixels).toEqual(
      new Uint8Array([1, 2, 3, 4]),
    );
    expect(pixels).toHaveBeenCalledWith({ target: content, frame, resolution: 1 });
    expect(preview.renderable).toBe(true);
  });
});
