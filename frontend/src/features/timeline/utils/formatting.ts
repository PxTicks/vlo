import type {
  BaseClip,
  ClipType,
  TimelineClip,
  TrackType,
} from "../../../types/TimelineTypes";

export const getTrackTypeFromClipType = (clipType: ClipType): TrackType => {
  switch (clipType) {
    case "video":
    case "image":
    case "text":
    case "shape":
    case "extension":
      return "visual";
    case "audio":
      return "audio";
    case "adjustment":
      return "adjustment";
    default:
      return "visual";
  }
};

export const getTrackTypeFromClip = (
  clip: Pick<BaseClip | TimelineClip, "type">,
): TrackType => {
  return getTrackTypeFromClipType(clip.type);
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
    case "adjustment":
      return "#5fa8ff";
    default:
      return "#607d8b";
  }
};

export { getTrackColor };
