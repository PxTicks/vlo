/**
 * Public feature barrel. It exposes only the factory, definition metadata,
 * defaults, and public parameter types. The child shader strings and validation
 * internals remain private to the feature.
 */
export { createMatrixRainFilter } from "./MatrixRainFilter";
export {
  DEFAULT_MATRIX_RAIN_PARAMETERS,
  MATRIX_RAIN_CONTROL_GROUPS,
  MATRIX_RAIN_RENDERING,
  MATRIX_RAIN_TRANSFORM_ID,
} from "./constants";
export { validateMatrixRainAuthoredParameters } from "./utils/parameterValidation";
export type { MatrixRainParameters } from "./types";
