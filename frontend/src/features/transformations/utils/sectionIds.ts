const DEFAULT_SECTION_PREFIX = "default:";
const DYNAMIC_SECTION_PREFIX = "dynamic:";

export { DEFAULT_SECTION_PREFIX, DYNAMIC_SECTION_PREFIX };

export function getDefaultSectionId(sectionType: string): string {
  return `${DEFAULT_SECTION_PREFIX}${sectionType}`;
}

export function getDynamicSectionId(transformId: string): string {
  return `${DYNAMIC_SECTION_PREFIX}${transformId}`;
}
