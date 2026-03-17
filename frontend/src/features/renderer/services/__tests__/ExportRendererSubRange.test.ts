// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import type { RenderOptions } from "../ExportRenderer";

describe("ExportRenderer - RenderOptions interface", () => {
  describe("RenderOptions type structure", () => {
    it("should allow all optional fields", () => {
      const options: RenderOptions = {};
      expect(options).toBeDefined();
    });

    it("should accept timelineSelection with start and end", () => {
      const options: RenderOptions = {
        timelineSelection: {
          start: 96000,
          end: 96000 * 5,
          clips: [],
        },
      };
      expect(options.timelineSelection?.start).toBe(96000);
      expect(options.timelineSelection?.end).toBe(96000 * 5);
    });

    it("should accept timelineSelection fps and frame step", () => {
      const options: RenderOptions = {
        timelineSelection: {
          start: 0,
          end: 96000,
          clips: [],
          fps: 24,
          frameStep: 4,
        },
      };
      expect(options.timelineSelection?.fps).toBe(24);
      expect(options.timelineSelection?.frameStep).toBe(4);
    });

    it("should accept timelineSelection with clip-store only", () => {
      const options: RenderOptions = {
        timelineSelection: {
          start: 96000,
          clips: [],
        },
      };
      expect(options.timelineSelection?.start).toBe(96000);
      expect(options.timelineSelection?.end).toBeUndefined();
    });

    it("should accept format mp4", () => {
      const options: RenderOptions = {
        format: "mp4",
      };
      expect(options.format).toBe("mp4");
    });

    it("should accept format webm", () => {
      const options: RenderOptions = {
        format: "webm",
      };
      expect(options.format).toBe("webm");
    });

    it("should accept combined options", () => {
      const options: RenderOptions = {
        timelineSelection: {
          start: 96000,
          end: 96000 * 3,
          clips: [],
        },
        format: "mp4",
      };
      expect(options.timelineSelection?.start).toBe(96000);
      expect(options.timelineSelection?.end).toBe(96000 * 3);
      expect(options.format).toBe("mp4");
    });
  });

  describe("Format options", () => {
    it("should define mp4 format", () => {
      const format: "mp4" | "webm" = "mp4";
      expect(format).toBe("mp4");
    });

    it("should define webm format", () => {
      const format: "mp4" | "webm" = "webm";
      expect(format).toBe("webm");
    });
  });
});
