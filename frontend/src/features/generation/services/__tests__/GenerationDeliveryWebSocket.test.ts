// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../generationDeliveryApi", () => ({
  parseGenerationDeliveryMessage: vi.fn(),
}));
vi.mock("../previewBinary", () => ({
  parseBinaryPreviewPayload: vi.fn(),
}));

import { parseGenerationDeliveryMessage } from "../generationDeliveryApi";
import { parseBinaryPreviewPayload } from "../previewBinary";
import { GenerationDeliveryWebSocket } from "../GenerationDeliveryWebSocket";

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  url: string;
  binaryType = "";
  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = MockWebSocket.CLOSED;
  }

  // --- test drivers ---
  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  emit(data: unknown): void {
    this.onmessage?.({ data });
  }

  fireClose(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
}

function latest(): MockWebSocket {
  const instance = MockWebSocket.instances.at(-1);
  if (!instance) throw new Error("no MockWebSocket instance");
  return instance;
}

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.stubGlobal("WebSocket", MockWebSocket);
  vi.mocked(parseGenerationDeliveryMessage).mockReset();
  vi.mocked(parseBinaryPreviewPayload).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("GenerationDeliveryWebSocket lifecycle", () => {
  it("connects, sets binaryType, and notifies on open", () => {
    const client = new GenerationDeliveryWebSocket("/api", "proj-1");
    const states: string[] = [];
    client.onConnectionChange((state) => states.push(state));

    client.connect();
    const ws = latest();
    expect(ws.url).toContain("/api/app/generation-delivery/ws?");
    expect(ws.url).toContain("projectId=proj-1");
    expect(ws.binaryType).toBe("arraybuffer");
    expect(client.isConnected).toBe(false);

    ws.open();
    expect(client.isConnected).toBe(true);
    expect(states).toEqual(["connected"]);
  });

  it("is idempotent while connecting or open", () => {
    const client = new GenerationDeliveryWebSocket("/api", "p");
    client.connect();
    client.connect(); // still CONNECTING -> no new socket
    expect(MockWebSocket.instances).toHaveLength(1);

    latest().open();
    client.connect(); // OPEN -> no new socket
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("disconnect closes the socket and suppresses reconnect", () => {
    vi.useFakeTimers();
    const client = new GenerationDeliveryWebSocket("/api", "p");
    client.connect();
    const ws = latest();
    ws.open();

    client.disconnect();
    expect(ws.closed).toBe(true);
    expect(client.isConnected).toBe(false);

    ws.fireClose();
    vi.advanceTimersByTime(5000);
    expect(MockWebSocket.instances).toHaveLength(1); // no reconnect
  });

  it("reconnects 3s after an unexpected close", () => {
    vi.useFakeTimers();
    const client = new GenerationDeliveryWebSocket("/api", "p");
    const states: string[] = [];
    client.onConnectionChange((state) => states.push(state));
    client.connect();
    latest().open();

    latest().fireClose();
    expect(states).toEqual(["connected", "disconnected"]);
    expect(MockWebSocket.instances).toHaveLength(1);

    vi.advanceTimersByTime(3000);
    expect(MockWebSocket.instances).toHaveLength(2); // reconnected
  });
});

describe("GenerationDeliveryWebSocket messaging", () => {
  function connected() {
    const client = new GenerationDeliveryWebSocket("/api", "p");
    client.connect();
    latest().open();
    return client;
  }

  it("dispatches parsed text messages to message handlers", () => {
    const client = connected();
    const received: unknown[] = [];
    client.onMessage((message) => received.push(message));
    vi.mocked(parseGenerationDeliveryMessage).mockReturnValue({
      type: "delivery",
    } as never);

    latest().emit('{"type":"delivery"}');
    expect(received).toEqual([{ type: "delivery" }]);
  });

  it("ignores text messages that fail to parse", () => {
    const client = connected();
    const received: unknown[] = [];
    client.onMessage((message) => received.push(message));
    vi.mocked(parseGenerationDeliveryMessage).mockReturnValue(null);

    latest().emit("garbage");
    expect(received).toEqual([]);
  });

  it("dispatches parsed binary previews to preview handlers", () => {
    const client = connected();
    const previews: unknown[] = [];
    client.onPreview((preview) => previews.push(preview));
    vi.mocked(parseBinaryPreviewPayload).mockReturnValue({
      nodeId: "n1",
    } as never);

    latest().emit(new ArrayBuffer(8));
    expect(previews).toEqual([{ nodeId: "n1" }]);
  });

  it("ignores binary payloads that parse to null and non-string text", () => {
    const client = connected();
    const previews: unknown[] = [];
    const messages: unknown[] = [];
    client.onPreview((preview) => previews.push(preview));
    client.onMessage((message) => messages.push(message));
    vi.mocked(parseBinaryPreviewPayload).mockReturnValue(null);

    latest().emit(new ArrayBuffer(4));
    latest().emit(42); // neither ArrayBuffer nor string
    expect(previews).toEqual([]);
    expect(messages).toEqual([]);
    expect(parseGenerationDeliveryMessage).not.toHaveBeenCalled();
  });

  it("unsubscribes handlers via the returned disposer", () => {
    const client = connected();
    const received: unknown[] = [];
    const off = client.onMessage((message) => received.push(message));
    vi.mocked(parseGenerationDeliveryMessage).mockReturnValue({ a: 1 } as never);

    off();
    latest().emit("{}");
    expect(received).toEqual([]);
  });
});

describe("GenerationDeliveryWebSocket ack / nack", () => {
  it("sends ack and nack frames only when connected", () => {
    const client = new GenerationDeliveryWebSocket("/api", "p");

    // not connected yet -> no-op
    client.acknowledgeDelivery("d1");
    client.rejectDelivery("d1", "boom");

    client.connect();
    const ws = latest();
    ws.open();

    client.acknowledgeDelivery("d1");
    client.rejectDelivery("d2", "boom");

    expect(ws.sent.map((s) => JSON.parse(s))).toEqual([
      { type: "ack", delivery_id: "d1" },
      { type: "nack", delivery_id: "d2", error: "boom" },
    ]);
  });
});

describe("GenerationDeliveryWebSocket preview sequence metadata", () => {
  type PrivateApi = {
    tryAbsorbPreviewSequenceMetadata: (data: string) => boolean;
    findPreviewSequenceMetadata: (nodeId: string) => unknown;
  };

  function privateApi(): PrivateApi {
    return new GenerationDeliveryWebSocket(
      "/api",
      "p",
    ) as unknown as PrivateApi;
  }

  it("absorbs valid VHS metadata and resolves it by exact and prefix match", () => {
    const api = privateApi();
    const absorbed = api.tryAbsorbPreviewSequenceMetadata(
      JSON.stringify({
        type: "VHS_latentpreview",
        data: { id: "node_1", rate: 8, length: 24 },
      }),
    );
    expect(absorbed).toBe(true);
    expect(api.findPreviewSequenceMetadata("node_1")).toMatchObject({
      frameRate: 8,
      totalFrames: 24,
    });
    // prefix match (stored id starts with the queried node id)
    expect(api.findPreviewSequenceMetadata("node")).toMatchObject({
      nodeId: "node_1",
    });
    expect(api.findPreviewSequenceMetadata("unrelated")).toBeNull();
  });

  it("rejects non-VHS and malformed metadata payloads", () => {
    const api = privateApi();
    expect(api.tryAbsorbPreviewSequenceMetadata("not json")).toBe(false);
    expect(
      api.tryAbsorbPreviewSequenceMetadata(JSON.stringify({ type: "other" })),
    ).toBe(false);
    // correct type but missing/invalid data is absorbed (returns true) yet stores nothing
    expect(
      api.tryAbsorbPreviewSequenceMetadata(
        JSON.stringify({ type: "VHS_latentpreview" }),
      ),
    ).toBe(true);
    expect(
      api.tryAbsorbPreviewSequenceMetadata(
        JSON.stringify({
          type: "VHS_latentpreview",
          data: { id: 5, rate: "x", length: null },
        }),
      ),
    ).toBe(true);
    expect(api.findPreviewSequenceMetadata("anything")).toBeNull();
  });
});
