import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComfyUIWebSocket } from "../ComfyUIWebSocket";

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
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

describe("ComfyUIWebSocket status channel", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("connects once and dispatches status and error events only", () => {
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
    expect(client.isConnected).toBe(false);
    expect(client.currentClientId).toBeTruthy();

    socket.open();
    expect(client.isConnected).toBe(true);
    expect(connections).toHaveBeenCalledWith("connected");

    socket.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "status",
          data: { status: { exec_info: { queue_remaining: 0 } } },
        }),
      }),
    );
    socket.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({ type: "error", data: { message: "boom" } }),
      }),
    );
    // Per-job events are unicast to the backend delivery monitor; even if one
    // arrives here it must be ignored.
    socket.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "progress",
          data: { value: 1, max: 2, prompt_id: "p", node: "n" },
        }),
      }),
    );
    socket.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify({ type: "unknown" }) }),
    );
    socket.onmessage?.(new MessageEvent("message", { data: "not json" }));
    expect(events).toHaveBeenCalledTimes(2);
    expect(events).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ type: "status" }),
    );
    expect(events).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ type: "error" }),
    );

    removeEvent();
    removeConnection();
    socket.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({ type: "error", data: { message: "ignored" } }),
      }),
    );
    expect(events).toHaveBeenCalledTimes(2);
  });

  it("ignores binary socket messages", () => {
    const client = new ComfyUIWebSocket("/api");
    const events = vi.fn();
    client.onEvent(events);
    client.connect();
    const socket = MockWebSocket.instances[0];

    socket.onmessage?.(
      new MessageEvent("message", { data: new Uint8Array([1, 2, 3]).buffer }),
    );
    expect(events).not.toHaveBeenCalled();
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
});
