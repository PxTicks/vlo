import {
  Animation,
  AutoAwesome,
  AutoFixHigh,
  Brush,
  Face,
  FolderOutlined,
  GraphicEq,
  Image,
  Layers,
  Movie,
  Palette,
  TextFields,
  Tune,
  ViewInAr,
} from "@mui/icons-material";
import type { SvgIconComponent } from "@mui/icons-material";
import type { MenuTreeNode } from "../../../core/shell/menuTree";

/**
 * Folders carry no icon of their own, so one is inferred from what the folder
 * is called. The list is ordered: the first keyword that appears in the label
 * or the node ID wins, so specific terms must precede the broad media ones
 * ("image"/"video") that would otherwise swallow them.
 */
const ICON_KEYWORDS: readonly (readonly [
  readonly string[],
  SvgIconComponent,
])[] = [
  [["upscale", "improve", "enhance", "restore", "quality", "refine"], AutoFixHigh],
  [["interpolat", "frame rate", "fps", "smooth"], Animation],
  [["generate", "create", "text to", "txt2", "new"], AutoAwesome],
  [["edit", "inpaint", "outpaint", "retouch", "paint"], Brush],
  [["control", "pose", "guide", "condition", "reference"], Tune],
  [["mask", "segment", "matte", "layer"], Layers],
  [["character", "face", "portrait", "person", "actor"], Face],
  [["style", "color", "colour", "grade", "palette", "look"], Palette],
  [["prompt", "text", "caption", "script"], TextFields],
  [["audio", "sound", "music", "voice", "speech"], GraphicEq],
  [["3d", "mesh", "depth", "camera", "scene"], ViewInAr],
  [["video", "movie", "clip", "motion", "animate"], Movie],
  [["image", "photo", "picture", "still", "frame"], Image],
];

export function resolveMenuNodeIcon(node: MenuTreeNode): SvgIconComponent {
  const haystack = `${node.label} ${node.id}`.toLowerCase();
  for (const [keywords, icon] of ICON_KEYWORDS) {
    if (keywords.some((keyword) => haystack.includes(keyword))) return icon;
  }
  return FolderOutlined;
}
