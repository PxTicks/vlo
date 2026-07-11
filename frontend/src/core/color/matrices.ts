import type { Matrix3, Rgb } from "./types";

export const REC709_TO_XYZ_D65: Matrix3 = Object.freeze([
  0.4123908, 0.35758434, 0.18048079,
  0.21263901, 0.71516868, 0.07219232,
  0.01933082, 0.11919478, 0.95053215,
]);

export const XYZ_D65_TO_REC709: Matrix3 = Object.freeze([
  3.24096994, -1.53738318, -0.49861076,
  -0.96924364, 1.8759675, 0.04155506,
  0.05563008, -0.20397696, 1.05697151,
]);

export const BT2020_TO_XYZ_D65: Matrix3 = Object.freeze([
  0.63695805, 0.1446169, 0.16888098,
  0.26270021, 0.67799807, 0.05930172,
  0, 0.02807269, 1.06098506,
]);

export const XYZ_D65_TO_BT2020: Matrix3 = Object.freeze([
  1.71665119, -0.35567078, -0.25336628,
  -0.66668435, 1.61648124, 0.01576855,
  0.01763986, -0.04277061, 0.94210312,
]);

const BRADFORD: Matrix3 = [
  0.8951, 0.2664, -0.1614,
  -0.7502, 1.7135, 0.0367,
  0.0389, -0.0685, 1.0296,
];

const BRADFORD_INVERSE: Matrix3 = [
  0.9869929, -0.1470543, 0.1599627,
  0.4323053, 0.5183603, 0.0492912,
  -0.0085287, 0.0400428, 0.9684867,
];

const D65_XY = Object.freeze([0.3127, 0.329]) as readonly [number, number];
const IDENTITY: Matrix3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function multiplyMatrix3(left: Matrix3, right: Matrix3): Matrix3 {
  const output = new Array<number>(9);
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      output[row * 3 + column] =
        left[row * 3] * right[column] +
        left[row * 3 + 1] * right[column + 3] +
        left[row * 3 + 2] * right[column + 6];
    }
  }
  return output as unknown as Matrix3;
}

export const BT2020_TO_REC709: Matrix3 = Object.freeze(
  multiplyMatrix3(XYZ_D65_TO_REC709, BT2020_TO_XYZ_D65),
);

export function applyMatrix3(matrix: Matrix3, value: Rgb): Rgb {
  return [
    matrix[0] * value[0] + matrix[1] * value[1] + matrix[2] * value[2],
    matrix[3] * value[0] + matrix[4] * value[1] + matrix[5] * value[2],
    matrix[6] * value[0] + matrix[7] * value[1] + matrix[8] * value[2],
  ];
}

function xyToXyz([x, y]: readonly [number, number]): Rgb {
  return [x / y, 1, (1 - x - y) / y];
}

function diagonal(values: Rgb): Matrix3 {
  return [values[0], 0, 0, 0, values[1], 0, 0, 0, values[2]];
}

export function bradfordAdaptationMatrix(
  sourceWhiteXy: readonly [number, number],
  destinationWhiteXy: readonly [number, number],
): Matrix3 {
  const sourceLms = applyMatrix3(BRADFORD, xyToXyz(sourceWhiteXy));
  const destinationLms = applyMatrix3(BRADFORD, xyToXyz(destinationWhiteXy));
  const scale: Rgb = [
    destinationLms[0] / sourceLms[0],
    destinationLms[1] / sourceLms[1],
    destinationLms[2] / sourceLms[2],
  ];
  return multiplyMatrix3(
    BRADFORD_INVERSE,
    multiplyMatrix3(diagonal(scale), BRADFORD),
  );
}

/**
 * Builds a Rec.709 RGB chromatic-adaptation matrix for the UI's -100..100
 * temperature/tint controls. Positive temperature warms; positive tint moves
 * away from green. The bounded xy offsets keep the v1 control predictable and
 * are deliberately part of the authored model rather than a Kelvin claim.
 */
export function whiteBalanceMatrix(
  temperature: number,
  tint: number,
): Matrix3 {
  const normalizedTemperature = Math.max(-1, Math.min(1, temperature / 100));
  const normalizedTint = Math.max(-1, Math.min(1, tint / 100));
  if (normalizedTemperature === 0 && normalizedTint === 0) return IDENTITY;

  const adjustedWhite: readonly [number, number] = [
    D65_XY[0] + normalizedTemperature * 0.035,
    D65_XY[1] + normalizedTemperature * 0.01 - normalizedTint * 0.025,
  ];
  const xyzAdaptation = bradfordAdaptationMatrix(D65_XY, adjustedWhite);
  return multiplyMatrix3(
    XYZ_D65_TO_REC709,
    multiplyMatrix3(xyzAdaptation, REC709_TO_XYZ_D65),
  );
}

export const MATRIX_GLSL = `
vec3 vloApplyMatrixRows(vec3 value, vec3 row0, vec3 row1, vec3 row2) {
  return vec3(dot(row0, value), dot(row1, value), dot(row2, value));
}
`;
