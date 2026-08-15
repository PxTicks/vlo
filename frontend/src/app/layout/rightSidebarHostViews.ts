import { createElement } from "react";
import { hostViewRegistry } from "../../core/shell/viewRegistry";
import { GenerationPanel } from "../../features/generation";
import { ModelWorkPanel } from "../../features/modelWork";
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

function renderAdjustPanel() {
  return createElement(TransformationPanel);
}

function renderEffectsPanel() {
  return createElement(EffectsPanel);
}

function renderMaskPanel() {
  return createElement(MaskPanel);
}

function renderModelWorkPanel() {
  return createElement(ModelWorkPanel);
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
    // "Adjust" owns a clip's built-in properties (Display/Speed/Audio/Color);
    // "Effects" owns transforms the user has added. Both render
    // TransformationPanelSurface under different variants, so the view IDs —
    // not the component name — are what distinguish them.
    id: "host.adjust",
    title: "Adjust",
    defaultRegion: "right-sidebar",
    order: 30,
    when: clipSelected,
    component: renderAdjustPanel,
  });
  hostViewRegistry.registerHostView({
    id: "host.effects",
    title: "Transform",
    defaultRegion: "right-sidebar",
    order: 40,
    when: clipSelected,
    component: renderEffectsPanel,
  });
  hostViewRegistry.registerHostView({
    // What the machine is doing, in one place: local model work and ComfyUI
    // generations share one GPU, so their queues are one queue.
    id: "host.queue",
    title: "Queue",
    defaultRegion: "right-sidebar",
    order: 15,
    keepMounted: true,
    component: renderModelWorkPanel,
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
