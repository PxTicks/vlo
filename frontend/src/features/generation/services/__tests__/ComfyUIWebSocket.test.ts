import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComfyUIWebSocket } from "../ComfyUIWebSocket";

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  });

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }
}

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
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

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

  it("parses offset-four websocket image packets", async () => {
    const client = new ComfyUIWebSocket("/api");
    const previews: Array<{ blob: Blob }> = [];

    client.onPreview((preview) => {
      previews.push(preview);
    });

    const bmpBytes = new Uint8Array([
      0x42,
      0x4d,
      0x0a,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
    ]);

    (client as unknown as { handleBinaryMessage: (data: ArrayBuffer) => void })
      .handleBinaryMessage(concatBytes(encodeUint32(1), bmpBytes));

    expect(previews).toHaveLength(1);
    expect(previews[0]?.blob.type).toBe("image/bmp");
    expect(previews[0]?.blob.size).toBe(bmpBytes.length);
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

  it("connects once, sends preview capabilities, and dispatches text events", () => {
    const client = new ComfyUIWebSocket("/api");
    const events = vi.fn();
    const connections = vi.fn();
    const removeEvent = client.onEvent(events);
    const removeConnection = client.onConnectionChange(connections);

    client.connect();
    client.connect();
    expect(MockWebSocket.instances).toHaveLength(1);
    const socket = MockWebSocket.instances[0];
    expect(socket.url).toContain("/api/comfy/ws?clientId=");
    expect(socket.binaryType).toBe("arraybuffer");
    expect(client.isConnected).toBe(false);
    expect(client.currentClientId).toBeTruthy();

    socket.open();
    expect(client.isConnected).toBe(true);
    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "feature_flags",
        data: { supports_preview_metadata: true },
      }),
    );
    expect(connections).toHaveBeenCalledWith("connected");

    socket.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "progress",
          data: { value: 1, max: 2, prompt_id: "p", node: "n" },
        }),
      }),
    );
    socket.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({ type: "feature_flags", data: {} }),
      }),
    );
    socket.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify({ type: "unknown" }) }),
    );
    socket.onmessage?.(new MessageEvent("message", { data: "not json" }));
    expect(events).toHaveBeenCalledTimes(1);

    removeEvent();
    removeConnection();
    socket.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({ type: "error", data: { message: "ignored" } }),
      }),
    );
    expect(events).toHaveBeenCalledTimes(1);
  });

  it("routes binary socket messages and ignores invalid packets", () => {
    const client = new ComfyUIWebSocket("/api");
    const previews = vi.fn();
    const removePreview = client.onPreview(previews);
    client.connect();
    const socket = MockWebSocket.instances[0];
    const bmpBytes = new Uint8Array([0x42, 0x4d, 0, 0, 0, 0]);

    socket.onmessage?.(
      new MessageEvent("message", {
        data: concatBytes(encodeUint32(1), bmpBytes),
      }),
    );
    socket.onmessage?.(
      new MessageEvent("message", { data: new Uint8Array([1]).buffer }),
    );
    expect(previews).toHaveBeenCalledTimes(1);

    removePreview();
    socket.onmessage?.(
      new MessageEvent("message", {
        data: concatBytes(encodeUint32(1), bmpBytes),
      }),
    );
    expect(previews).toHaveBeenCalledTimes(1);
  });

  it("reconnects after unexpected closure and disconnects explicitly", () => {
    vi.useFakeTimers();
    const client = new ComfyUIWebSocket("/api");
    const connections = vi.fn();
    client.onConnectionChange(connections);
    client.connect();
    const first = MockWebSocket.instances[0];

    first.readyState = MockWebSocket.CLOSED;
    first.onclose?.();
    expect(connections).not.toHaveBeenCalledWith("disconnected");
    vi.advanceTimersByTime(3000);
    expect(MockWebSocket.instances).toHaveLength(2);

    const second = MockWebSocket.instances[1];
    second.open();
    client.disconnect();
    expect(second.close).toHaveBeenCalled();
    expect(connections).toHaveBeenLastCalledWith("disconnected");
    expect(client.isConnected).toBe(false);
    vi.advanceTimersByTime(3000);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it("clears an existing reconnect timer when a replacement socket opens", () => {
    vi.useFakeTimers();
    const client = new ComfyUIWebSocket("/api");
    client.connect();
    const first = MockWebSocket.instances[0];
    first.readyState = MockWebSocket.CLOSED;
    first.onclose?.();
    vi.advanceTimersByTime(3000);
    const second = MockWebSocket.instances[1];
    second.readyState = MockWebSocket.CLOSED;
    second.onclose?.();
    second.open();
    vi.advanceTimersByTime(3000);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it("matches preview sequence metadata across composite node identifiers", () => {
    const client = new ComfyUIWebSocket("/api");
    const internal = client as unknown as {
      handleTextMessage(data: string): void;
      findPreviewSequenceMetadata(nodeId: string): {
        frameRate: number;
        nodeId: string;
        totalFrames: number;
      } | null;
    };
    internal.handleTextMessage(
      JSON.stringify({
        type: "VHS_latentpreview",
        data: { id: "node.12", length: 8, rate: 4 },
      }),
    );

    expect(internal.findPreviewSequenceMetadata("node.12")).toMatchObject({
      totalFrames: 8,
    });
    expect(internal.findPreviewSequenceMetadata("node")).toMatchObject({
      nodeId: "node.12",
    });
    expect(internal.findPreviewSequenceMetadata("node.12.preview")).toMatchObject({
      frameRate: 4,
    });
    expect(internal.findPreviewSequenceMetadata("missing")).toBeNull();
  });
});
