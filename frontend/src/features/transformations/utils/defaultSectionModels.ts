import type { TransformationDefinition } from "../catalogue/types";
import { getDefaultSectionId } from "./sectionIds";

interface BundledSection {
  sectionType: string;
  title: string;
  /** Membership test for the definitions the section bundles, in panel order. */
  includes: (definition: TransformationDefinition) => boolean;
}

const LAYOUT_DEFINITION_TYPES = new Set(["layout", "fitMode"]);
const BLEND_DEFINITION_TYPES = new Set(["opacity", "blendMode"]);

// Sections that bundle several definitions, one titled sub-group per group:
// - "Layout": position / scale / rotation (one shared keyframe track, keyed
//   from the section header) plus fit mode.
// - "Blend": opacity and blend mode.
// - "Audio": volume with the audio effects, which share
//   `compatibleClips: "audio"`.
const BUNDLED_SECTIONS: readonly BundledSection[] = [
  {
    sectionType: "layout",
    title: "Layout",
    includes: (definition) => LAYOUT_DEFINITION_TYPES.has(definition.type),
  },
  {
    sectionType: "blend",
    title: "Blend",
    includes: (definition) => BLEND_DEFINITION_TYPES.has(definition.type),
  },
  {
    sectionType: "audio",
    title: "Audio",
    includes: (definition) => definition.compatibleClips === "audio",
  },
];

export interface DefaultTransformationSectionModel {
  sectionId: string;
  title: string;
  definitions: TransformationDefinition[];
  hideGroupTitles?: boolean;
}

export function getDefaultTransformationSectionModels(
  definitions: TransformationDefinition[],
): DefaultTransformationSectionModel[] {
  return definitions.flatMap((definition): DefaultTransformationSectionModel[] => {
    const bundle = BUNDLED_SECTIONS.find((candidate) => candidate.includes(definition));
    if (!bundle) {
      return [
        {
          sectionId: getDefaultSectionId(definition.type),
          title: definition.label,
          definitions: [definition],
        },
      ];
    }

    // Emit the bundled section once, at its first definition.
    const bundled = definitions.filter(bundle.includes);
    if (bundled[0] !== definition) {
      return [];
    }
    return [
      {
        sectionId: getDefaultSectionId(bundle.sectionType),
        title: bundle.title,
        definitions: bundled,
      },
    ];
  });
}
