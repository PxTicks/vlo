import { describe, expect, it, vi } from "vitest";
import {
  BINARY_PREVIEW_IMAGE,
  BINARY_PREVIEW_IMAGE_WITH_METADATA,
  parseBinaryPreviewPayload,
} from "../previewBinary";

const PNG = [0x89, 0x50, 0x4e, 0x47];
const JPEG = [0xff, 0xd8, 0xff];
const GIF87 = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61];
const GIF89 = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
const BMP = [0x42, 0x4d];
const WEBP = [
  0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
];

function payload(
  eventType: number,
  size: number,
  writes: Array<{ offset: number; bytes: number[] }> = [],
): ArrayBuffer {
  const buffer = new ArrayBuffer(size);
  new DataView(buffer).setUint32(0, eventType, false);
  const bytes = new Uint8Array(buffer);
  for (const write of writes) {
    bytes.set(write.bytes, write.offset);
  }
  return buffer;
}

function metadataPayload(
  metadata: string,
  imageBytes: number[],
): ArrayBuffer {
  const encodedMetadata = new TextEncoder().encode(metadata);
  const buffer = new ArrayBuffer(8 + encodedMetadata.length + imageBytes.length);
  const view = new DataView(buffer);
  view.setUint32(0, BINARY_PREVIEW_IMAGE_WITH_METADATA, false);
  view.setUint32(4, encodedMetadata.length, false);
  const bytes = new Uint8Array(buffer);
  bytes.set(encodedMetadata, 8);
  bytes.set(imageBytes, 8 + encodedMetadata.length);
  return buffer;
}

describe("parseBinaryPreviewPayload", () => {
  it("rejects short and unsupported event payloads", () => {
    expect(parseBinaryPreviewPayload(new ArrayBuffer(3))).toBeNull();
    expect(parseBinaryPreviewPayload(payload(99, 8))).toBeNull();
  });

  it("rejects malformed metadata envelopes", () => {
    expect(
      parseBinaryPreviewPayload(
        payload(BINARY_PREVIEW_IMAGE_WITH_METADATA, 7),
      ),
    ).toBeNull();

    const overflow = payload(BINARY_PREVIEW_IMAGE_WITH_METADATA, 12);
    new DataView(overflow).setUint32(4, 100, false);
    expect(parseBinaryPreviewPayload(overflow)).toBeNull();
  });

  it("parses metadata and trusts a detected image signature", () => {
    const result = parseBinaryPreviewPayload(
      metadataPayload(
        JSON.stringify({
          image_type: "jpeg",
          node_id: "node-1",
          prompt_id: "prompt-1",
        }),
        PNG,
      ),
    );

    expect(result).toMatchObject({
      nodeId: "node-1",
      promptId: "prompt-1",
    });
    expect(result?.blob.type).toBe("image/png");
  });

  it.each([
    ["jpg", "image/jpeg"],
    ["jpeg", "image/jpeg"],
    ["png", "image/png"],
    ["webp", "image/webp"],
    ["bmp", "image/bmp"],
    ["gif", "image/gif"],
    ["image/jpg", "image/jpeg"],
    ["image/png", "image/png"],
  ])("normalizes metadata image type %s", (imageType, expectedMime) => {
    const result = parseBinaryPreviewPayload(
      metadataPayload(JSON.stringify({ image_type: imageType }), [1, 2, 3]),
    );
    expect(result?.blob.type).toBe(expectedMime);
  });

  it("falls back safely for malformed, empty, and unknown metadata", () => {
    expect(
      parseBinaryPreviewPayload(metadataPayload("{", [1]))?.blob.type,
    ).toBe("application/octet-stream");
    expect(
      parseBinaryPreviewPayload(metadataPayload("", [1]))?.blob.type,
    ).toBe("application/octet-stream");
    expect(
      parseBinaryPreviewPayload(
        metadataPayload(JSON.stringify({ image_type: 12 }), [1]),
      )?.blob.type,
    ).toBe("application/octet-stream");
    expect(
      parseBinaryPreviewPayload(
        metadataPayload(JSON.stringify({ image_type: "tiff" }), [1]),
      )?.blob.type,
    ).toBe("application/octet-stream");
  });

  it.each([
    [PNG, "image/png"],
    [JPEG, "image/jpeg"],
    [GIF87, "image/gif"],
    [GIF89, "image/gif"],
    [BMP, "image/bmp"],
    [WEBP, "image/webp"],
  ])("detects an image signature after the standard header", (bytes, mime) => {
    const result = parseBinaryPreviewPayload(
      payload(BINARY_PREVIEW_IMAGE, 32, [{ offset: 8, bytes }]),
    );
    expect(result?.blob.type).toBe(mime);
    expect(result?.blob.size).toBe(24);
  });

  it("accepts image data immediately after the event type", () => {
    const result = parseBinaryPreviewPayload(
      payload(BINARY_PREVIEW_IMAGE, 16, [{ offset: 4, bytes: JPEG }]),
    );
    expect(result?.blob.type).toBe("image/jpeg");
    expect(result?.blob.size).toBe(12);
  });

  it("decodes VHS latent preview metadata and sequence information", () => {
    const buffer = payload(BINARY_PREVIEW_IMAGE, 48, [
      { offset: 32, bytes: PNG },
    ]);
    const view = new DataView(buffer);
    view.setUint32(12, 7, false);
    new Uint8Array(buffer).set(
      [6, ...new TextEncoder().encode("node-a")],
      16,
    );
    const lookup = vi.fn(() => ({
      frameRate: 24,
      nodeId: "resolved-node",
      totalFrames: 12,
    }));

    const result = parseBinaryPreviewPayload(buffer, lookup);

    expect(lookup).toHaveBeenCalledWith("node-a");
    expect(result).toMatchObject({
      frameIndex: 7,
      frameRate: 24,
      nodeId: "resolved-node",
      totalFrames: 12,
    });
  });

  it("keeps decoded VHS metadata when no sequence lookup is available", () => {
    const buffer = payload(BINARY_PREVIEW_IMAGE, 48, [
      { offset: 32, bytes: BMP },
    ]);
    new Uint8Array(buffer).set(
      [6, ...new TextEncoder().encode("node-b")],
      16,
    );

    expect(parseBinaryPreviewPayload(buffer)).toMatchObject({
      frameIndex: 0,
      nodeId: "node-b",
    });
  });

  it("discovers signatures in nonstandard headers", () => {
    const result = parseBinaryPreviewPayload(
      payload(BINARY_PREVIEW_IMAGE, 24, [{ offset: 13, bytes: GIF89 }]),
    );
    expect(result?.blob.type).toBe("image/gif");
    expect(result?.blob.size).toBe(11);
  });

  it.each([
    [1, "image/jpeg"],
    [2, "image/png"],
    [3, "image/webp"],
    [9, "application/octet-stream"],
  ])("uses numeric image type %i as a fallback", (imageType, mime) => {
    const buffer = payload(BINARY_PREVIEW_IMAGE, 12);
    new DataView(buffer).setUint32(4, imageType, false);
    expect(parseBinaryPreviewPayload(buffer)?.blob.type).toBe(mime);
  });

  it("returns an opaque four-byte payload when no header is present", () => {
    const result = parseBinaryPreviewPayload(
      payload(BINARY_PREVIEW_IMAGE, 4),
    );
    expect(result?.blob.type).toBe("application/octet-stream");
    expect(result?.blob.size).toBe(0);
  });
});
