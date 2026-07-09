import type {
  BuiltinTransitionType,
  Transition,
  TransitionType,
} from "../../../types/TimelineTypes";
import { extensionTransitionRegistry } from "../extensions/ExtensionTransitionRegistry";
import type { TransitionDefinition } from "./types";
import type { ControlDefinition } from "../../panelUI/types";

const DIRECTION_CONTROL: ControlDefinition = {
  type: "select",
  label: "Direction",
  name: "direction",
  defaultValue: "left",
  options: [
    { label: "Left", value: "left" },
    { label: "Right", value: "right" },
    { label: "Up", value: "up" },
    { label: "Down", value: "down" },
  ],
};

const SPIN_DIRECTION_CONTROL: ControlDefinition = {
  type: "select",
  label: "Direction",
  name: "direction",
  defaultValue: "clockwise",
  options: [
    { label: "Clockwise", value: "clockwise" },
    { label: "Counter-clockwise", value: "counterclockwise" },
  ],
};

const EASING_CONTROL: ControlDefinition = {
  type: "select",
  label: "Easing",
  name: "easing",
  defaultValue: "easeInOut",
  options: [
    { label: "Linear", value: "linear" },
    { label: "Ease in/out", value: "easeInOut" },
    { label: "Ease in", value: "easeIn" },
    { label: "Ease out", value: "easeOut" },
  ],
};

export const TransitionRegistry: readonly TransitionDefinition[] = [
  {
    type: "dissolve",
    label: "Dissolve",
    glyph: "◐",
    parameters: { easing: "easeInOut" },
    uiConfig: {
      groups: [
        {
          id: "timing",
          title: "Timing",
          controls: [EASING_CONTROL],
        },
      ],
    },
  },
  {
    type: "slideAway",
    label: "Slide away",
    glyph: "↗",
    parameters: {
      direction: "left",
      distance: 1,
      easing: "easeInOut",
    },
    hijackZOrder: true,
    uiConfig: {
      groups: [
        {
          id: "motion",
          title: "Motion",
          controls: [
            DIRECTION_CONTROL,
            {
              type: "slider",
              label: "Distance",
              name: "distance",
              defaultValue: 1,
              min: 0.1,
              max: 2,
              step: 0.05,
            },
            EASING_CONTROL,
          ],
        },
      ],
    },
  },
  {
    type: "slideOutIn",
    label: "Slide out / in",
    glyph: "⇄",
    parameters: {
      direction: "left",
      distance: 1,
      easing: "easeInOut",
    },
    uiConfig: {
      groups: [
        {
          id: "motion",
          title: "Motion",
          controls: [
            DIRECTION_CONTROL,
            {
              type: "slider",
              label: "Distance",
              name: "distance",
              defaultValue: 1,
              min: 0.1,
              max: 2,
              step: 0.05,
            },
            EASING_CONTROL,
          ],
        },
      ],
    },
  },
  {
    type: "dipToColor",
    label: "Fade through color",
    glyph: "◆",
    parameters: {
      color: "#000000",
      easing: "easeInOut",
    },
    uiConfig: {
      groups: [
        {
          id: "appearance",
          title: "Appearance",
          controls: [
            {
              type: "color",
              label: "Color",
              name: "color",
              defaultValue: "#000000",
            },
            EASING_CONTROL,
          ],
        },
      ],
    },
  },
  {
    type: "zoom",
    label: "Zoom",
    glyph: "⤢",
    parameters: {
      scale: 1.4,
      easing: "easeInOut",
    },
    uiConfig: {
      groups: [
        {
          id: "motion",
          title: "Motion",
          controls: [
            {
              type: "slider",
              label: "Zoom",
              name: "scale",
              defaultValue: 1.4,
              min: 1.05,
              max: 3,
              step: 0.05,
            },
            EASING_CONTROL,
          ],
        },
      ],
    },
  },
  {
    type: "spin",
    label: "Spin",
    glyph: "↻",
    parameters: {
      direction: "clockwise",
      rotations: 1,
      easing: "easeInOut",
    },
    uiConfig: {
      groups: [
        {
          id: "motion",
          title: "Motion",
          controls: [
            SPIN_DIRECTION_CONTROL,
            {
              type: "slider",
              label: "Rotations",
              name: "rotations",
              defaultValue: 1,
              min: 0.25,
              max: 4,
              step: 0.25,
            },
            EASING_CONTROL,
          ],
        },
      ],
    },
  },
  {
    type: "whipPan",
    label: "Whip pan",
    glyph: "»",
    parameters: {
      direction: "left",
      blur: 12,
      easing: "easeInOut",
    },
    uiConfig: {
      groups: [
        {
          id: "motion",
          title: "Motion",
          controls: [
            DIRECTION_CONTROL,
            {
              type: "slider",
              label: "Blur",
              name: "blur",
              defaultValue: 12,
              min: 0,
              max: 20,
              step: 0.5,
            },
            EASING_CONTROL,
          ],
        },
      ],
    },
  },
];

let registeredTransitionRevision = -1;
let registeredTransitionDefinitions: readonly TransitionDefinition[] =
  TransitionRegistry;

export function getTransitionRegistryRevision(): number {
  return extensionTransitionRegistry.getRevision();
}

export function subscribeTransitionRegistry(listener: () => void): () => void {
  return extensionTransitionRegistry.subscribe(listener);
}

export function getTransitionDefinitions(): readonly TransitionDefinition[] {
  const revision = extensionTransitionRegistry.getRevision();
  if (revision !== registeredTransitionRevision) {
    registeredTransitionRevision = revision;
    registeredTransitionDefinitions = Object.freeze([
      ...TransitionRegistry,
      ...extensionTransitionRegistry.listDefinitions(),
    ]);
  }
  return registeredTransitionDefinitions;
}

export function isBuiltinTransitionType(
  type: TransitionType,
): type is BuiltinTransitionType {
  return (
    type === "dissolve" ||
    type === "slideAway" ||
    type === "slideOutIn" ||
    type === "dipToColor" ||
    type === "zoom" ||
    type === "spin" ||
    type === "whipPan"
  );
}

export function findTransitionDefinition(
  type: TransitionType,
): TransitionDefinition | undefined {
  return getTransitionDefinitions().find(
    (definition) => definition.type === type,
  );
}

export function getTransitionDefinition(
  type: TransitionType,
): TransitionDefinition {
  return (
    findTransitionDefinition(type) ??
    TransitionRegistry[0]
  );
}

export function validateTransitionParameters(
  transition: Transition,
  parameters: Readonly<Record<string, unknown>>,
): boolean {
  const definition = findTransitionDefinition(transition.type);
  const extension = definition?.extension;
  if (!extension) return true;
  return extension.validateParameters(
    parameters,
    transition.schemaVersion ?? definition.schemaVersion ?? 1,
  );
}

export function validateTransitionParameterUpdates(
  transition: Transition,
  updates: Readonly<Record<string, unknown>>,
): boolean {
  return validateTransitionParameters(transition, {
    ...transition.parameters,
    ...updates,
  });
}

export function createTransition(
  type: TransitionType,
  outgoingClipId: string,
  incomingClipId: string,
): Transition {
  const definition = getTransitionDefinition(type);
  return {
    id: `transition_${crypto.randomUUID()}`,
    type,
    outgoingClipId,
    incomingClipId,
    ...(definition.schemaVersion
      ? { schemaVersion: definition.schemaVersion }
      : {}),
    parameters: structuredClone(definition.parameters),
  };
}

export type { TransitionDefinition };
