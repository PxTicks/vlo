export const BINARY_PREVIEW_IMAGE = 1;
export const BINARY_PREVIEW_IMAGE_WITH_METADATA = 4;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
const VHS_LATENT_PREVIEW_NODE_ID_OFFSET = 16;
const VHS_LATENT_PREVIEW_NODE_ID_LENGTH = 16;
const VHS_LATENT_PREVIEW_FRAME_INDEX_OFFSET = 12;
const VHS_LATENT_PREVIEW_IMAGE_OFFSET = 32;
const MAX_PREVIEW_SIGNATURE_OFFSET = 256;

export interface PreviewSequenceMetadata {
  frameRate: number;
  nodeId: string;
  totalFrames: number;
}

export interface ParsedBinaryPreview {
  blob: Blob;
  frameIndex?: number;
  frameRate?: number;
  nodeId?: string;
  promptId?: string;
  totalFrames?: number;
}

const textDecoder = new TextDecoder();

function matchesSignature(
  bytes: Uint8Array,
  offset: number,
  signature: number[],
): boolean {
  if (offset + signature.length > bytes.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[offset + i] !== signature[i]) {
      return false;
    }
  }
  return true;
}

function detectMimeAtOffset(bytes: Uint8Array, offset: number): string | null {
  if (offset >= bytes.length) return null;
  if (matchesSignature(bytes, offset, PNG_SIGNATURE)) {
    return "image/png";
  }
  if (matchesSignature(bytes, offset, JPEG_SIGNATURE)) {
    return "image/jpeg";
  }
  return null;
}

function findImagePayload(
  bytes: Uint8Array,
  startOffset: number,
): { payloadOffset: number; mimeType: string } | null {
  const maxOffset = Math.min(
    bytes.length,
    Math.max(startOffset, MAX_PREVIEW_SIGNATURE_OFFSET),
  );

  for (let offset = startOffset; offset < maxOffset; offset += 1) {
    const mimeType = detectMimeAtOffset(bytes, offset);
    if (mimeType) {
      return { payloadOffset: offset, mimeType };
    }
  }

  return null;
}

function decodePascalString(bytes: Uint8Array): string | undefined {
  if (bytes.length === 0) return undefined;
  const stringLength = Math.min(bytes[0], bytes.length - 1);
  if (stringLength <= 0) return undefined;
  return textDecoder.decode(bytes.slice(1, stringLength + 1));
}

function buildPreview(
  data: ArrayBuffer,
  payloadOffset: number,
  mimeType: string,
  metadata: Omit<ParsedBinaryPreview, "blob"> = {},
): ParsedBinaryPreview {
  const imageData = data.slice(payloadOffset);
  return {
    ...metadata,
    blob: new Blob([imageData], { type: mimeType }),
  };
}

function parsePreviewImageWithMetadataPayload(
  data: ArrayBuffer,
): ParsedBinaryPreview | null {
  if (data.byteLength < 8) {
    return null;
  }

  const bytes = new Uint8Array(data);
  const view = new DataView(data);
  const metadataLength = view.getUint32(4, false);
  const metadataStart = 8;
  const payloadOffset = metadataStart + metadataLength;

  if (payloadOffset > data.byteLength) {
    return null;
  }

  let metadata:
    | {
        image_type?: string;
        node_id?: string;
        prompt_id?: string;
      }
    | null = null;

  if (metadataLength > 0) {
    try {
      metadata = JSON.parse(
        textDecoder.decode(bytes.slice(metadataStart, payloadOffset)),
      ) as {
        image_type?: string;
        node_id?: string;
        prompt_id?: string;
      };
    } catch {
      metadata = null;
    }
  }

  const mimeType =
    metadata?.image_type ??
    detectMimeAtOffset(bytes, payloadOffset) ??
    "application/octet-stream";

  return buildPreview(data, payloadOffset, mimeType, {
    nodeId: metadata?.node_id,
    promptId: metadata?.prompt_id,
  });
}

export function parseBinaryPreviewPayload(
  data: ArrayBuffer,
  sequenceMetadataLookup?: (nodeId: string) => PreviewSequenceMetadata | null,
): ParsedBinaryPreview | null {
  if (data.byteLength < 4) return null;

  const view = new DataView(data);
  const eventType = view.getUint32(0, false);

  if (
    eventType !== BINARY_PREVIEW_IMAGE &&
    eventType !== BINARY_PREVIEW_IMAGE_WITH_METADATA
  ) {
    return null;
  }

  if (eventType === BINARY_PREVIEW_IMAGE_WITH_METADATA) {
    return parsePreviewImageWithMetadataPayload(data);
  }

  const bytes = new Uint8Array(data);

  // SaveImageWebsocket payloads often include an 8-byte header before image bytes.
  const mimeAt8 = detectMimeAtOffset(bytes, 8);
  if (mimeAt8) {
    return buildPreview(data, 8, mimeAt8);
  }

  const mimeAt4 = detectMimeAtOffset(bytes, 4);
  if (mimeAt4) {
    return buildPreview(data, 4, mimeAt4);
  }

  const mimeAtVhsOffset = detectMimeAtOffset(
    bytes,
    VHS_LATENT_PREVIEW_IMAGE_OFFSET,
  );
  if (mimeAtVhsOffset) {
    const nodeId = decodePascalString(
      bytes.slice(
        VHS_LATENT_PREVIEW_NODE_ID_OFFSET,
        VHS_LATENT_PREVIEW_NODE_ID_OFFSET + VHS_LATENT_PREVIEW_NODE_ID_LENGTH,
      ),
    );
    const sequenceMetadata =
      nodeId && sequenceMetadataLookup
        ? sequenceMetadataLookup(nodeId)
        : null;

    return buildPreview(
      data,
      VHS_LATENT_PREVIEW_IMAGE_OFFSET,
      mimeAtVhsOffset,
      {
        frameIndex: view.getUint32(VHS_LATENT_PREVIEW_FRAME_INDEX_OFFSET, false),
        frameRate: sequenceMetadata?.frameRate,
        nodeId: sequenceMetadata?.nodeId ?? nodeId,
        totalFrames: sequenceMetadata?.totalFrames,
      },
    );
  }

  const discoveredPayload = findImagePayload(bytes, 4);
  if (discoveredPayload) {
    return buildPreview(
      data,
      discoveredPayload.payloadOffset,
      discoveredPayload.mimeType,
    );
  }

  if (data.byteLength >= 8) {
    const imageType = view.getUint32(4, false);
    if (imageType === 1) {
      return buildPreview(data, 8, "image/jpeg");
    }
    if (imageType === 2) {
      return buildPreview(data, 8, "image/png");
    }
    return buildPreview(data, 8, "application/octet-stream");
  }

  return buildPreview(data, 4, "application/octet-stream");
}
