import type { AspectRatio } from "../../project/useProjectStore";

const FIXED_VERTICAL_RESOLUTION = 1080;

export const getProjectDimensions = (ratio: AspectRatio) => {
  const [widthPart, heightPart] = ratio.split(":").map(Number);

  if (
    !Number.isFinite(widthPart) ||
    !Number.isFinite(heightPart) ||
    heightPart === 0
  ) {
    return { width: 1920, height: FIXED_VERTICAL_RESOLUTION };
  }

  return {
    width: Math.round((FIXED_VERTICAL_RESOLUTION * widthPart) / heightPart),
    height: FIXED_VERTICAL_RESOLUTION,
  };
};
