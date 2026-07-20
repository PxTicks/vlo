const EXTENSION_MASK_PREFIX = "extension/";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Uses `/` because it is forbidden in extension IDs, making the owner segment
 * exact even when IDs contain dots, hyphens, or underscores.
 */
export function createExtensionMaskLocalId(
  ownerId: string,
  uuid: string,
): string {
  return `${EXTENSION_MASK_PREFIX}${ownerId}/${uuid}`;
}

export function getExtensionMaskOwnerId(maskId: string): string | null {
  if (!maskId.startsWith(EXTENSION_MASK_PREFIX)) return null;
  const segments = maskId.slice(EXTENSION_MASK_PREFIX.length).split("/");
  if (segments.length !== 2) return null;
  const [ownerId, uuid] = segments;
  if (!ownerId || !uuid || !UUID_PATTERN.test(uuid)) return null;
  return ownerId;
}
