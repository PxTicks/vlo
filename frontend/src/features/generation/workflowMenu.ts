import {
  MENU_TREE_VERSION,
  type MenuTreeDefinition,
} from "../../core/shell/menuTree";

export const DEFAULT_GENERATION_WORKFLOW_MENU: MenuTreeDefinition = {
  version: MENU_TREE_VERSION,
  id: "generation.workflows",
  nodes: [
    { id: "video", kind: "category", label: "Video", parentId: null, order: 0 },
    { id: "video.generate", kind: "folder", label: "Generate", parentId: "video", order: 0 },
    { id: "video.edit", kind: "folder", label: "Edit", parentId: "video", order: 1 },
    { id: "video.control", kind: "folder", label: "Control", parentId: "video", order: 2 },
    { id: "video.enhance", kind: "folder", label: "Enhance", parentId: "video", order: 3 },
    { id: "image", kind: "category", label: "Image", parentId: null, order: 1 },
    { id: "image.generate", kind: "folder", label: "Generate", parentId: "image", order: 0 },
    { id: "image.enhance", kind: "folder", label: "Enhance", parentId: "image", order: 1 },
  ],
  leafPlacements: [
    { leafId: "vlo_ltx2_5.json", parentId: "video.generate", order: 0 },
    { leafId: "vlo_wan2_2.json", parentId: "video.generate", order: 1 },
    { leafId: "vlo_minimax_h3_i2v.json", parentId: "video.generate", order: 2 },
    { leafId: "vlo_minimax_h3_r2v.json", parentId: "video.generate", order: 3 },
    { leafId: "vlo_VACE_inpaint.json", parentId: "video.edit", order: 0 },
    { leafId: "vlo_ltx2_5_inpaint.json", parentId: "video.edit", order: 1 },
    { leafId: "vlo_ltx2_5_ic_edit.json", parentId: "video.edit", order: 2 },
    { leafId: "vlo_wan_ttm.json", parentId: "video.control", order: 0 },
    { leafId: "vlo_wan_animate.json", parentId: "video.control", order: 1 },
    { leafId: "vlo_SeedVR2_video.json", parentId: "video.enhance", order: 0 },
    { leafId: "vlo_gimm_vfi.json", parentId: "video.enhance", order: 1 },
    { leafId: "vlo_klein_multi.json", parentId: "image.generate", order: 0 },
    { leafId: "vlo_SeedVR2_image.json", parentId: "image.enhance", order: 0 },
  ],
};
