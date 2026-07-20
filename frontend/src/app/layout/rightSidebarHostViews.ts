import { createElement } from "react";
import { hostViewRegistry } from "../../core/shell/viewRegistry";
import { GenerationPanel } from "../../features/generation";
import {
  EffectsPanel,
  TransformationPanel,
} from "../../features/transformations";
import { TransitionPanel } from "../../features/transitions";
import { MaskPanel } from "../../features/masks";

let installed = false;

// Registration runs while feature catalogues may still be initializing. Stable
// wrappers defer reading their barrel bindings until React renders the view.
function renderGenerationPanel() {
  return createElement(GenerationPanel);
}

function renderTransitionPanel() {
  return createElement(TransitionPanel);
}

function renderTransformationPanel() {
  return createElement(TransformationPanel);
}

function renderEffectsPanel() {
  return createElement(EffectsPanel);
}

function renderMaskPanel() {
  return createElement(MaskPanel);
}

export function declareRightSidebarHostViews(): void {
  if (installed) return;
  installed = true;
  const clipSelected = { key: "selection.clipCount" } as const;
  hostViewRegistry.registerHostView({
    id: "host.generate",
    title: "Generate",
    defaultRegion: "right-sidebar",
    order: 10,
    keepMounted: true,
    eager: true,
    component: renderGenerationPanel,
  });
  hostViewRegistry.registerHostView({
    id: "host.transition",
    title: "Transition",
    defaultRegion: "right-sidebar",
    order: 20,
    when: { key: "selection.transitionSelected" },
    component: renderTransitionPanel,
  });
  hostViewRegistry.registerHostView({
    id: "host.adjust",
    title: "Adjust",
    defaultRegion: "right-sidebar",
    order: 30,
    when: clipSelected,
    component: renderTransformationPanel,
  });
  hostViewRegistry.registerHostView({
    id: "host.transformations",
    title: "Transform",
    defaultRegion: "right-sidebar",
    order: 40,
    when: clipSelected,
    component: renderEffectsPanel,
  });
  hostViewRegistry.registerHostView({
    id: "host.mask",
    title: "Mask",
    defaultRegion: "right-sidebar",
    order: 50,
    when: {
      and: [
        clipSelected,
        { not: { key: "selection.clipType", equals: "adjustment" } },
      ],
    },
    component: renderMaskPanel,
  });
}
