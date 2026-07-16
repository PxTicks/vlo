import { describe, expect, it } from "vitest";
import {
  COMPOSITE_DECODED_PIXEL_TOLERANCE,
  COMPOSITE_PREENCODE_PIXEL_TOLERANCE,
  captureCompositeParityFrames,
  captureExtractedCompositePixels,
  compareCompositePixelFrames,
  createCompositeCoordinateProbeFrame,
  type CompositePixelFrame,
} from "../compositeParityHarness";

function shiftedRight(frame: CompositePixelFrame): CompositePixelFrame {
  const pixels = new Uint8ClampedArray(frame.pixels.length);
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width - 1; x += 1) {
      const sourceOffset = (y * frame.width + x) * 4;
      const targetOffset = (y * frame.width + x + 1) * 4;
      pixels.set(frame.pixels.subarray(sourceOffset, sourceOffset + 4), targetOffset);
    }
  }
  return { ...frame, pixels };
}

describe("composite parity harness", () => {
  it("captures independent snapshots for all equivalence stages", async () => {
    const probe = createCompositeCoordinateProbeFrame(9, 7);
    const captures = await captureCompositeParityFrames({
      live: () => probe.frame,
      preEncode: async () => probe.frame,
      decodedBake: () => probe.frame,
    });

    probe.frame.pixels.fill(255);

    expect(captures.live.pixels[0]).toBe(0);
    expect(captures.preEncode.pixels).not.toBe(captures.live.pixels);
    expect(captures.decodedBake).toMatchObject({ width: 9, height: 7 });
  });

  it("adapts Pixi-style extraction results", () => {
    const probe = createCompositeCoordinateProbeFrame(5, 5);
    const capture = captureExtractedCompositePixels(() => ({
      width: probe.frame.width,
      height: probe.frame.height,
      pixels: new Uint8Array(probe.frame.pixels),
    }));

    expect(capture).toEqual(probe.frame);
  });

  it("keeps transparent margins and unique fixed coordinate markers", () => {
    const { frame, probes } = createCompositeCoordinateProbeFrame(9, 7, 1);

    for (let x = 0; x < frame.width; x += 1) {
      expect(frame.pixels[(x * 4) + 3]).toBe(0);
      const bottomAlpha = ((frame.height - 1) * frame.width + x) * 4 + 3;
      expect(frame.pixels[bottomAlpha]).toBe(0);
    }
    expect(new Set(probes.map((probe) => probe.rgba.join(","))).size).toBe(5);
    for (const probe of probes) {
      const offset = (probe.y * frame.width + probe.x) * 4;
      expect([...frame.pixels.slice(offset, offset + 4)]).toEqual(probe.rgba);
    }
  });

  it("passes strict identical frames and catches anchor/coordinate shifts", () => {
    const { frame } = createCompositeCoordinateProbeFrame(9, 7);
    const identical = compareCompositePixelFrames(
      frame,
      frame,
      COMPOSITE_PREENCODE_PIXEL_TOLERANCE,
    );
    const shifted = compareCompositePixelFrames(
      frame,
      shiftedRight(frame),
      COMPOSITE_PREENCODE_PIXEL_TOLERANCE,
    );

    expect(identical).toMatchObject({ passed: true, maxChannelDelta: 0 });
    expect(shifted).toMatchObject({ passed: false, dimensionsMatch: true });
    expect(shifted.differentPixelCount).toBeGreaterThan(0);
  });

  it("uses a documented separate tolerance for decoded lossy output", () => {
    const { frame } = createCompositeCoordinateProbeFrame(9, 7);
    const decodedPixels = new Uint8ClampedArray(frame.pixels);
    for (let index = 0; index < decodedPixels.length; index += 1) {
      decodedPixels[index] = Math.min(255, decodedPixels[index] + 4);
    }

    const decoded = compareCompositePixelFrames(
      frame,
      { ...frame, pixels: decodedPixels },
      COMPOSITE_DECODED_PIXEL_TOLERANCE,
    );
    expect(decoded.passed).toBe(true);
  });

  it("rejects malformed RGBA captures", async () => {
    const malformed = {
      width: 2,
      height: 2,
      pixels: new Uint8ClampedArray(3),
    };
    await expect(
      captureCompositeParityFrames({
        live: () => malformed,
        preEncode: () => malformed,
        decodedBake: () => malformed,
      }),
    ).rejects.toThrow("expected 16 RGBA bytes");
  });
});
