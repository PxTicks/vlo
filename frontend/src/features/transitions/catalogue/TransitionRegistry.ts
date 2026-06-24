import type {
  ControlDefinition,
  LayoutGroup,
} from "../../panelUI/types";
import type {
  Transition,
  TransitionType,
} from "../../../types/TimelineTypes";

export interface TransitionDefinition {
  type: TransitionType;
  label: string;
  glyph: string;
  parameters: Record<string, unknown>;
  uiConfig: {
    groups: LayoutGroup[];
  };
  hijackZOrder?: boolean;
}

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
];

export function getTransitionDefinition(
  type: TransitionType,
): TransitionDefinition {
  return (
    TransitionRegistry.find((definition) => definition.type === type) ??
    TransitionRegistry[0]
  );
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
    parameters: structuredClone(definition.parameters),
  };
}
