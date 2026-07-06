/**
 * Golden-fixture parity tests: the fixtures are generated from the backend
 * implementation (`scripts/generate_processing_parity_fixtures.py`) and the
 * same files run against the backend in
 * `backend/tests/test_generation_processing_parity.py`. Any divergence
 * between the two implementations fails one side or the other.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveTrueDimensionsFromShortEdge,
  findBestStridedDimensions,
  parseAspectRatioParts,
} from "../aspectRatioProcessing";
import {
  computeCropRegion,
  computeMaskCrop,
  forceAspectRatio,
  getMaskBoundsFromChannel,
  unionBounds,
  type MaskBounds,
} from "../maskCropMath";

// Vitest runs with cwd = frontend/ (jsdom rewrites import.meta.url, so a
// URL-relative path is not usable here).
const FIXTURES_DIR = resolve(
  process.cwd(),
  "../shared/fixtures/generation-processing",
);

function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(FIXTURES_DIR, name), "utf-8")) as T;
}

interface AspectRatioFixture {
  parse_aspect_ratio: {
    input: string;
    expected: [number, number] | null;
  }[];
  derive_true_dimensions_from_short_edge: {
    aspect_ratio: string;
    resolution: number;
    expected: [number, number] | null;
  }[];
  find_best_strided_dimensions: {
    target_width: number;
    target_height: number;
    stride: number;
    search_steps: number;
    expected: Record<string, number> | null;
  }[];
}

interface MaskCropFixture {
  union_bounds: {
    a: MaskBounds | null;
    b: MaskBounds | null;
    expected: MaskBounds | null;
  }[];
  force_aspect_ratio: {
    bbox: MaskBounds;
    target_ar: number;
    expected: [number, number, number, number];
  }[];
  compute_crop_region: {
    bbox: [number, number, number, number];
    dilation: number;
    container_w: number;
    container_h: number;
    target_ar: number;
    expected: MaskBounds;
  }[];
  compute_mask_crop: {
    bounds: MaskBounds | null;
    container_w: number;
    container_h: number;
    target_ar: number;
    dilation: number;
    expected: MaskBounds | null;
  }[];
  get_mask_bounds_from_frame: {
    width: number;
    height: number;
    rects: { x1: number; y1: number; x2: number; y2: number; value: number }[];
    threshold: number;
    expected: MaskBounds | null;
  }[];
}

describe("aspect-ratio processing parity fixtures", () => {
  const fixture = loadFixture<AspectRatioFixture>("aspect-ratio-cases.json");

  it("parseAspectRatioParts matches the backend", () => {
    for (const { input, expected } of fixture.parse_aspect_ratio) {
      expect(parseAspectRatioParts(input), `input: ${JSON.stringify(input)}`).toEqual(
        expected,
      );
    }
  });

  it("deriveTrueDimensionsFromShortEdge matches the backend", () => {
    for (const {
      aspect_ratio,
      resolution,
      expected,
    } of fixture.derive_true_dimensions_from_short_edge) {
      expect(
        deriveTrueDimensionsFromShortEdge(aspect_ratio, resolution),
        `${aspect_ratio} @ ${resolution}`,
      ).toEqual(expected);
    }
  });

  it("findBestStridedDimensions matches the backend", () => {
    for (const testCase of fixture.find_best_strided_dimensions) {
      const label = `${testCase.target_width}x${testCase.target_height} stride=${testCase.stride} steps=${testCase.search_steps}`;
      expect(
        findBestStridedDimensions(
          testCase.target_width,
          testCase.target_height,
          testCase.stride,
          testCase.search_steps,
        ),
        label,
      ).toEqual(testCase.expected);
    }
  });
});

describe("mask-crop math parity fixtures", () => {
  const fixture = loadFixture<MaskCropFixture>("mask-crop-cases.json");

  it("unionBounds matches the backend", () => {
    for (const { a, b, expected } of fixture.union_bounds) {
      expect(unionBounds(a, b)).toEqual(expected);
    }
  });

  it("forceAspectRatio matches the backend", () => {
    for (const { bbox, target_ar, expected } of fixture.force_aspect_ratio) {
      expect(
        forceAspectRatio(bbox, target_ar),
        `bbox=[${bbox.join(",")}] ar=${target_ar}`,
      ).toEqual(expected);
    }
  });

  it("computeCropRegion matches the backend", () => {
    for (const testCase of fixture.compute_crop_region) {
      expect(
        computeCropRegion(
          testCase.bbox,
          testCase.dilation,
          testCase.container_w,
          testCase.container_h,
          testCase.target_ar,
        ),
        `bbox=[${testCase.bbox.join(",")}] dilation=${testCase.dilation} container=${testCase.container_w}x${testCase.container_h}`,
      ).toEqual(testCase.expected);
    }
  });

  it("computeMaskCrop matches the backend", () => {
    for (const testCase of fixture.compute_mask_crop) {
      expect(
        computeMaskCrop(
          testCase.bounds,
          testCase.container_w,
          testCase.container_h,
          testCase.target_ar,
          testCase.dilation,
        ),
        `bounds=${JSON.stringify(testCase.bounds)} container=${testCase.container_w}x${testCase.container_h} dilation=${testCase.dilation}`,
      ).toEqual(testCase.expected);
    }
  });

  it("getMaskBoundsFromChannel matches the backend", () => {
    for (const testCase of fixture.get_mask_bounds_from_frame) {
      const channel = new Uint8Array(testCase.width * testCase.height);
      for (const rect of testCase.rects) {
        for (let y = rect.y1; y < rect.y2; y += 1) {
          channel.fill(rect.value, y * testCase.width + rect.x1, y * testCase.width + rect.x2);
        }
      }
      expect(
        getMaskBoundsFromChannel(
          channel,
          testCase.width,
          testCase.height,
          testCase.threshold,
        ),
        `rects=${JSON.stringify(testCase.rects)} threshold=${testCase.threshold}`,
      ).toEqual(testCase.expected);
    }
  });
});
