import type { Rgb } from "./types";

/**
 * Adobe/Resolve `.cube` LUT. 3D data is packed r-fastest (r, then g, then b),
 * matching the file format's row order; 1D data is one rgb triple per input
 * sample. Values are stored exactly as parsed — domain mapping happens at
 * sample time.
 */
export interface CubeLut {
  readonly title: string | null;
  readonly dimensions: 1 | 3;
  readonly size: number;
  readonly domainMin: Rgb;
  readonly domainMax: Rgb;
  /** rgb triples; length = size * 3 (1D) or size³ * 3 (3D). */
  readonly data: Float32Array;
}

export const MAX_CUBE_LUT_3D_SIZE = 65;
export const MAX_CUBE_LUT_1D_SIZE = 65536;

export class CubeLutParseError extends Error {
  public readonly line: number | null;

  constructor(message: string, line: number | null = null) {
    super(line === null ? message : `${message} (line ${line})`);
    this.name = "CubeLutParseError";
    this.line = line;
  }
}

function parseTriple(
  tokens: readonly string[],
  keyword: string,
  lineNumber: number,
): Rgb {
  if (tokens.length !== 3) {
    throw new CubeLutParseError(
      `${keyword} expects three numbers`,
      lineNumber,
    );
  }
  const values = tokens.map(Number);
  if (values.some((value) => !Number.isFinite(value))) {
    throw new CubeLutParseError(
      `${keyword} contains a non-numeric value`,
      lineNumber,
    );
  }
  return [values[0], values[1], values[2]];
}

export function parseCubeLut(text: string): CubeLut {
  let title: string | null = null;
  let dimensions: 1 | 3 | null = null;
  let size = 0;
  let domainMin: Rgb = [0, 0, 0];
  let domainMax: Rgb = [1, 1, 1];
  let data: Float32Array | null = null;
  let dataCursor = 0;

  const lines = text.split(/\r\n|\r|\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index].trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const tokens = line.split(/\s+/);
    const keyword = tokens[0].toUpperCase();

    if (keyword === "TITLE") {
      title = line.slice(tokens[0].length).trim().replace(/^"|"$/g, "");
      continue;
    }
    if (keyword === "LUT_1D_SIZE" || keyword === "LUT_3D_SIZE") {
      if (dimensions !== null) {
        throw new CubeLutParseError("Duplicate LUT size declaration", lineNumber);
      }
      const declaredSize = Number(tokens[1]);
      const is3d = keyword === "LUT_3D_SIZE";
      const maxSize = is3d ? MAX_CUBE_LUT_3D_SIZE : MAX_CUBE_LUT_1D_SIZE;
      if (
        !Number.isInteger(declaredSize) ||
        declaredSize < 2 ||
        declaredSize > maxSize
      ) {
        throw new CubeLutParseError(
          `${keyword} must be an integer in [2, ${maxSize}]`,
          lineNumber,
        );
      }
      dimensions = is3d ? 3 : 1;
      size = declaredSize;
      data = new Float32Array((is3d ? size * size * size : size) * 3);
      continue;
    }
    if (keyword === "DOMAIN_MIN" || keyword === "LUT_1D_INPUT_RANGE" || keyword === "LUT_3D_INPUT_RANGE") {
      if (keyword === "DOMAIN_MIN") {
        domainMin = parseTriple(tokens.slice(1), keyword, lineNumber);
      } else {
        // Legacy IRIDAS form: "<keyword> <min> <max>" applied to all channels.
        const low = Number(tokens[1]);
        const high = Number(tokens[2]);
        if (!Number.isFinite(low) || !Number.isFinite(high)) {
          throw new CubeLutParseError(
            `${keyword} expects two numbers`,
            lineNumber,
          );
        }
        domainMin = [low, low, low];
        domainMax = [high, high, high];
      }
      continue;
    }
    if (keyword === "DOMAIN_MAX") {
      domainMax = parseTriple(tokens.slice(1), keyword, lineNumber);
      continue;
    }

    // Anything else must be a data row of three floats.
    const triple = tokens.map(Number);
    if (triple.length !== 3 || triple.some((value) => !Number.isFinite(value))) {
      throw new CubeLutParseError(
        `Unrecognized line: "${line.slice(0, 40)}"`,
        lineNumber,
      );
    }
    if (data === null) {
      throw new CubeLutParseError(
        "Data row before LUT_1D_SIZE/LUT_3D_SIZE",
        lineNumber,
      );
    }
    if (dataCursor + 3 > data.length) {
      throw new CubeLutParseError("More data rows than the LUT size allows", lineNumber);
    }
    data[dataCursor] = triple[0];
    data[dataCursor + 1] = triple[1];
    data[dataCursor + 2] = triple[2];
    dataCursor += 3;
  }

  if (dimensions === null || data === null) {
    throw new CubeLutParseError("Missing LUT_1D_SIZE/LUT_3D_SIZE declaration");
  }
  if (dataCursor !== data.length) {
    throw new CubeLutParseError(
      `Expected ${data.length / 3} data rows, found ${dataCursor / 3}`,
    );
  }
  for (let channel = 0; channel < 3; channel += 1) {
    if (!(domainMax[channel] > domainMin[channel])) {
      throw new CubeLutParseError(
        "DOMAIN_MAX must exceed DOMAIN_MIN on every channel",
      );
    }
  }

  return { title, dimensions, size, domainMin, domainMax, data };
}

function formatCubeNumber(value: number): string {
  if (Number.isInteger(value)) return value.toFixed(1);
  return Number(value.toFixed(6)).toString();
}

export function serializeCubeLut(lut: CubeLut): string {
  const lines: string[] = [];
  if (lut.title) lines.push(`TITLE "${lut.title}"`);
  lines.push(
    lut.dimensions === 3 ? `LUT_3D_SIZE ${lut.size}` : `LUT_1D_SIZE ${lut.size}`,
  );
  const defaultDomain =
    lut.domainMin.every((value) => value === 0) &&
    lut.domainMax.every((value) => value === 1);
  if (!defaultDomain) {
    lines.push(`DOMAIN_MIN ${lut.domainMin.map(formatCubeNumber).join(" ")}`);
    lines.push(`DOMAIN_MAX ${lut.domainMax.map(formatCubeNumber).join(" ")}`);
  }
  for (let offset = 0; offset < lut.data.length; offset += 3) {
    lines.push(
      `${formatCubeNumber(lut.data[offset])} ${formatCubeNumber(
        lut.data[offset + 1],
      )} ${formatCubeNumber(lut.data[offset + 2])}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Maps a color into the LUT's normalized [0,1] input domain. */
function normalizeToDomain(lut: CubeLut, color: Rgb): Rgb {
  return [
    clamp01((color[0] - lut.domainMin[0]) / (lut.domainMax[0] - lut.domainMin[0])),
    clamp01((color[1] - lut.domainMin[1]) / (lut.domainMax[1] - lut.domainMin[1])),
    clamp01((color[2] - lut.domainMin[2]) / (lut.domainMax[2] - lut.domainMin[2])),
  ];
}

function lattice3d(lut: CubeLut, r: number, g: number, b: number): Rgb {
  const offset = ((b * lut.size + g) * lut.size + r) * 3;
  return [lut.data[offset], lut.data[offset + 1], lut.data[offset + 2]];
}

function sample1dChannel(lut: CubeLut, channel: 0 | 1 | 2, normalized: number): number {
  const scaled = normalized * (lut.size - 1);
  const left = Math.min(lut.size - 2, Math.floor(scaled));
  const amount = scaled - left;
  const leftValue = lut.data[left * 3 + channel];
  const rightValue = lut.data[(left + 1) * 3 + channel];
  return leftValue + (rightValue - leftValue) * amount;
}

/**
 * Reference LUT evaluation: per-channel linear for 1D, tetrahedral for 3D.
 * The GLSL implementation in the color-grade shader mirrors this branch
 * structure exactly; parity tests compare the two through the atlas bake.
 */
export function sampleCubeLut(lut: CubeLut, color: Rgb): Rgb {
  const normalized = normalizeToDomain(lut, color);
  if (lut.dimensions === 1) {
    return [
      sample1dChannel(lut, 0, normalized[0]),
      sample1dChannel(lut, 1, normalized[1]),
      sample1dChannel(lut, 2, normalized[2]),
    ];
  }

  const maxIndex = lut.size - 1;
  const position = normalized.map((value) => value * maxIndex);
  const base = position.map((value) =>
    Math.max(0, Math.min(maxIndex - 1, Math.floor(value))),
  );
  const [r, g, b] = base;
  const f: Rgb = [position[0] - r, position[1] - g, position[2] - b];

  const c000 = lattice3d(lut, r, g, b);
  const c111 = lattice3d(lut, r + 1, g + 1, b + 1);
  let weights: [number, number, number, number];
  let cA: Rgb;
  let cB: Rgb;
  if (f[0] >= f[1]) {
    if (f[1] >= f[2]) {
      weights = [1 - f[0], f[0] - f[1], f[1] - f[2], f[2]];
      cA = lattice3d(lut, r + 1, g, b);
      cB = lattice3d(lut, r + 1, g + 1, b);
    } else if (f[0] >= f[2]) {
      weights = [1 - f[0], f[0] - f[2], f[2] - f[1], f[1]];
      cA = lattice3d(lut, r + 1, g, b);
      cB = lattice3d(lut, r + 1, g, b + 1);
    } else {
      weights = [1 - f[2], f[2] - f[0], f[0] - f[1], f[1]];
      cA = lattice3d(lut, r, g, b + 1);
      cB = lattice3d(lut, r + 1, g, b + 1);
    }
  } else if (f[2] >= f[1]) {
    weights = [1 - f[2], f[2] - f[1], f[1] - f[0], f[0]];
    cA = lattice3d(lut, r, g, b + 1);
    cB = lattice3d(lut, r, g + 1, b + 1);
  } else if (f[2] >= f[0]) {
    weights = [1 - f[1], f[1] - f[2], f[2] - f[0], f[0]];
    cA = lattice3d(lut, r, g + 1, b);
    cB = lattice3d(lut, r, g + 1, b + 1);
  } else {
    weights = [1 - f[1], f[1] - f[0], f[0] - f[2], f[2]];
    cA = lattice3d(lut, r, g + 1, b);
    cB = lattice3d(lut, r + 1, g + 1, b);
  }

  return [
    weights[0] * c000[0] + weights[1] * cA[0] + weights[2] * cB[0] + weights[3] * c111[0],
    weights[0] * c000[1] + weights[1] * cA[1] + weights[2] * cB[1] + weights[3] * c111[1],
    weights[0] * c000[2] + weights[1] * cA[2] + weights[2] * cB[2] + weights[3] * c111[2],
  ];
}

/**
 * Expands a 1D LUT to an equivalent 3D lattice for the GPU atlas. Per-channel
 * curves are separable, and tetrahedral interpolation has linear precision
 * along each axis, so sampling the expansion reproduces the 1D linear
 * interpolation exactly when the original size is preserved. Oversized 1D
 * LUTs are resampled down to `maxSize`.
 */
export function expandCubeLutTo3d(
  lut: CubeLut,
  maxSize = MAX_CUBE_LUT_3D_SIZE,
): CubeLut {
  if (lut.dimensions === 3) return lut;
  const size = Math.min(lut.size, maxSize);
  const data = new Float32Array(size * size * size * 3);
  const channelSamples = [0, 1, 2].map((channel) =>
    Array.from({ length: size }, (_, index) =>
      sample1dChannel(lut, channel as 0 | 1 | 2, index / (size - 1)),
    ),
  );
  let offset = 0;
  for (let b = 0; b < size; b += 1) {
    for (let g = 0; g < size; g += 1) {
      for (let r = 0; r < size; r += 1) {
        data[offset] = channelSamples[0][r];
        data[offset + 1] = channelSamples[1][g];
        data[offset + 2] = channelSamples[2][b];
        offset += 3;
      }
    }
  }
  return {
    title: lut.title,
    dimensions: 3,
    size,
    domainMin: lut.domainMin,
    domainMax: lut.domainMax,
    data,
  };
}

export function createIdentityCubeLut(size: number): CubeLut {
  const data = new Float32Array(size * size * size * 3);
  let offset = 0;
  for (let b = 0; b < size; b += 1) {
    for (let g = 0; g < size; g += 1) {
      for (let r = 0; r < size; r += 1) {
        data[offset] = r / (size - 1);
        data[offset + 1] = g / (size - 1);
        data[offset + 2] = b / (size - 1);
        offset += 3;
      }
    }
  }
  return {
    title: null,
    dimensions: 3,
    size,
    domainMin: [0, 0, 0],
    domainMax: [1, 1, 1],
    data,
  };
}
