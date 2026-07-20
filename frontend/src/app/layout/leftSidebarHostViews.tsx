import VideoLibraryIcon from "@mui/icons-material/VideoLibrary";
import TextFieldsIcon from "@mui/icons-material/TextFields";
import LayersIcon from "@mui/icons-material/Layers";
import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh";
import CompareArrowsIcon from "@mui/icons-material/CompareArrows";
import { hostViewRegistry } from "../../core/shell/viewRegistry";
import { TextPanel } from "../../features/text";
import { CompositePanel } from "../../features/composite";
import { TransformationLibraryPanel } from "../../features/transformations";
import { TransitionLibraryPanel } from "../../features/transitions";
import { AssetsSidebarView } from "./AssetsSidebarView";

let installed = false;

// Keep these barrel bindings behind render-time wrappers: their feature
// catalogues participate in existing cycles and may still be initializing when
// this registration module first evaluates.
function renderTransformationLibrary() {
  return <TransformationLibraryPanel />;
}

function renderTransitionLibrary() {
  return <TransitionLibraryPanel />;
}

export function declareLeftSidebarHostViews(): void {
  if (installed) return;
  installed = true;
  hostViewRegistry.registerHostView({
    id: "host.assets",
    title: "Assets",
    icon: () => <VideoLibraryIcon fontSize="small" />,
    defaultRegion: "left-sidebar",
    order: 10,
    component: AssetsSidebarView,
  });
  hostViewRegistry.registerHostView({
    id: "host.text",
    title: "Text",
    icon: () => <TextFieldsIcon fontSize="small" />,
    defaultRegion: "left-sidebar",
    order: 20,
    component: TextPanel,
  });
  hostViewRegistry.registerHostView({
    id: "host.composite",
    title: "Composite",
    icon: () => <LayersIcon fontSize="small" />,
    defaultRegion: "left-sidebar",
    order: 30,
    component: CompositePanel,
  });
  hostViewRegistry.registerHostView({
    id: "host.effects-library",
    title: "Effects",
    icon: () => <AutoFixHighIcon fontSize="small" />,
    defaultRegion: "left-sidebar",
    order: 40,
    component: renderTransformationLibrary,
  });
  hostViewRegistry.registerHostView({
    id: "host.transitions-library",
    title: "Transitions",
    icon: () => <CompareArrowsIcon fontSize="small" />,
    defaultRegion: "left-sidebar",
    order: 50,
    component: renderTransitionLibrary,
  });
}
