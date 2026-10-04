import type { TransformationDefinition } from "../catalogue/types";
import { getDefaultSectionId } from "./sectionIds";

const DISPLAY_SECTION_TYPE = "display";
// Layout (position/scale/rotation), Fit Mode and Blend Mode are unified into a
// single "Display" section — one section with a titled sub-group per transform.
const DISPLAY_DEFINITION_TYPES = new Set(["layout", "fitMode", "blendMode"]);

const AUDIO_SECTION_TYPE = "audio";

export interface DefaultTransformationSectionModel {
  sectionId: string;
  title: string;
  definitions: TransformationDefinition[];
  hideGroupTitles?: boolean;
}

// Volume + the audio effects share `compatibleClips: "audio"` and are bundled
// into a single "Audio" section — one section with a sub-group per effect, the
// same shape as the Layout section (position/scale/rotation) and Display
// (fitMode/blendMode).
function isAudioDefinition(definition: TransformationDefinition): boolean {
  return definition.compatibleClips === "audio";
}

export function getDefaultTransformationSectionModels(
  definitions: TransformationDefinition[],
): DefaultTransformationSectionModel[] {
  const displayDefinitions = definitions.filter((definition) =>
    DISPLAY_DEFINITION_TYPES.has(definition.type),
  );
  const audioDefinitions = definitions.filter(isAudioDefinition);

  return definitions.flatMap((definition): DefaultTransformationSectionModel[] => {
    if (DISPLAY_DEFINITION_TYPES.has(definition.type)) {
      if (displayDefinitions[0]?.type !== definition.type) {
        return [];
      }

      return [
        {
          sectionId: getDefaultSectionId(DISPLAY_SECTION_TYPE),
          title: "Display",
          definitions: displayDefinitions,
        },
      ];
    }

    if (isAudioDefinition(definition)) {
      // Emit the bundled section once, at the first audio definition.
      if (audioDefinitions[0]?.type !== definition.type) {
        return [];
      }

      return [
        {
          sectionId: getDefaultSectionId(AUDIO_SECTION_TYPE),
          title: "Audio",
          definitions: audioDefinitions,
        },
      ];
    }

    return [
      {
        sectionId: getDefaultSectionId(definition.type),
        title: definition.label,
        definitions: [definition],
      },
    ];
  });
}
