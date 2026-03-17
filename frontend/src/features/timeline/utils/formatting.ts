import type { TrackType, ClipType } from "../../../types/TimelineTypes";

export const getTrackTypeFromClipType = (clipType: ClipType): TrackType => {
  switch (clipType) {
    case "video":
    case "image":
    case "text":
    case "shape":
      return "visual";
    case "audio":
      return "audio";
    default:
      return "visual";
  }
};

const getTrackColor = (type: TrackType) => {
  switch (type) {
    case "visual":
      return "#3f51b5";
    case "audio":
      return "#f50057";
    case "effects":
      return "#9c27b0";
    case "prompt":
      return "#ff9800";
    default:
      return "#607d8b";
  }
};

export { getTrackColor };
