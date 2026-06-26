import type { TransformationDefinition } from "../catalogue/types";
import { getDefaultSectionId } from "./sectionKeyframes";

const DISPLAY_SECTION_TYPE = "display";
const DISPLAY_DEFINITION_TYPES = new Set(["fitMode", "blendMode"]);

export interface DefaultTransformationSectionModel {
  sectionId: string;
  title: string;
  definitions: TransformationDefinition[];
  hideGroupTitles?: boolean;
}

export function getDefaultTransformationSectionModels(
  definitions: TransformationDefinition[],
): DefaultTransformationSectionModel[] {
  const displayDefinitions = definitions.filter((definition) =>
    DISPLAY_DEFINITION_TYPES.has(definition.type),
  );

  return definitions.flatMap((definition) => {
    if (DISPLAY_DEFINITION_TYPES.has(definition.type)) {
      if (displayDefinitions[0]?.type !== definition.type) {
        return [];
      }

      return [
        {
          sectionId: getDefaultSectionId(DISPLAY_SECTION_TYPE),
          title: "Display",
          definitions: displayDefinitions,
          hideGroupTitles: true,
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
