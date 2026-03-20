import { describe, expect, it } from "vitest";
import { ComfyUIWebSocket } from "../ComfyUIWebSocket";

function encodeUint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function encodePascalString(value: string, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const encoded = new TextEncoder().encode(value);
  const storedLength = Math.min(encoded.length, length - 1);
  bytes[0] = storedLength;
  bytes.set(encoded.slice(0, storedLength), 1);
  return bytes;
}

function concatBytes(...parts: Uint8Array[]): ArrayBuffer {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.length;
  }
  return combined.buffer;
}

describe("ComfyUIWebSocket preview parsing", () => {
  it("parses preview packets with metadata payloads", async () => {
    const client = new ComfyUIWebSocket("/api");
    const previews: Array<{
      blob: Blob;
      nodeId?: string;
      promptId?: string;
    }> = [];

    client.onPreview((preview) => {
      previews.push(preview);
    });

    const metadata = new TextEncoder().encode(
      JSON.stringify({
        image_type: "image/png",
        node_id: "node-12",
        prompt_id: "prompt-12",
      }),
    );
    const pngBytes = new Uint8Array([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
    ]);

    (client as unknown as { handleBinaryMessage: (data: ArrayBuffer) => void })
      .handleBinaryMessage(
        concatBytes(encodeUint32(4), encodeUint32(metadata.length), metadata, pngBytes),
      );

    expect(previews).toHaveLength(1);
    expect(previews[0]?.nodeId).toBe("node-12");
    expect(previews[0]?.promptId).toBe("prompt-12");
    expect(previews[0]?.blob.type).toBe("image/png");
    expect(previews[0]?.blob.size).toBe(pngBytes.length);
  });

  it("parses VHS latent preview packets with frame metadata", async () => {
    const client = new ComfyUIWebSocket("/api");
    const previews: Array<{
      blob: Blob;
      frameIndex?: number;
      frameRate?: number;
      nodeId?: string;
      totalFrames?: number;
    }> = [];

    client.onPreview((preview) => {
      previews.push(preview);
    });

    (client as unknown as { handleTextMessage: (data: string) => void })
      .handleTextMessage(
        JSON.stringify({
          type: "VHS_latentpreview",
          data: {
            id: "node_1",
            length: 24,
            rate: 8,
          },
        }),
      );

    const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43]);
    (client as unknown as { handleBinaryMessage: (data: ArrayBuffer) => void })
      .handleBinaryMessage(
        concatBytes(
          encodeUint32(1),
          encodeUint32(1),
          encodeUint32(1),
          encodeUint32(5),
          encodePascalString("node_1", 16),
          jpegBytes,
        ),
      );

    expect(previews).toHaveLength(1);
    expect(previews[0]?.frameIndex).toBe(5);
    expect(previews[0]?.frameRate).toBe(8);
    expect(previews[0]?.nodeId).toBe("node_1");
    expect(previews[0]?.totalFrames).toBe(24);
    expect(previews[0]?.blob.type).toBe("image/jpeg");
    expect(previews[0]?.blob.size).toBe(jpegBytes.length);
  });
});
