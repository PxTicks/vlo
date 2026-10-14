import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockResponse, stubFetch } from "../../../../testUtils/fetch";
import { API_BASE_URL } from "../../../../config";
import {
  fetchModelWorkSnapshot,
  parseModelWorkMessage,
  releaseModelWorkEntry,
} from "../modelWorkApi";
import { ModelWorkWebSocket } from "../ModelWorkWebSocket";

describe("modelWorkApi", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses snapshot and event messages and rejects anything else", () => {
    const snapshot = { revision: 3, ready: true, entries: [], resources: [] };
    expect(
      parseModelWorkMessage(JSON.stringify({ type: "snapshot", data: snapshot })),
    ).toEqual({ type: "snapshot", data: snapshot });

    const event = { revision: 4, kind: "removed", entry: {}, resources: [] };
    expect(
      parseModelWorkMessage(JSON.stringify({ type: "event", data: event })),
    ).toEqual({ type: "event", data: event });

    for (const raw of [
      "not json",
      "null",
      JSON.stringify({ type: "snapshot" }),
      JSON.stringify({ type: "snapshot", data: { revision: "3" } }),
      JSON.stringify({ type: "event", data: {} }),
      JSON.stringify({ type: "other", data: { revision: 1 } }),
    ]) {
      expect(parseModelWorkMessage(raw)).toBeNull();
    }
  });

  it("fetches the ledger snapshot and surfaces HTTP failures", async () => {
    const snapshot = { revision: 1, ready: true, entries: [], resources: [] };
    const fetchMock = stubFetch(
      createMockResponse({ json: snapshot }),
      createMockResponse({ status: 503 }),
    );
    const controller = new AbortController();

    await expect(fetchModelWorkSnapshot(controller.signal)).resolves.toEqual(
      snapshot,
    );
    expect(fetchMock).toHaveBeenCalledWith(`${API_BASE_URL}/app/model-work`, {
      signal: controller.signal,
    });
    await expect(fetchModelWorkSnapshot()).rejects.toThrow(
      "Failed to load model work (503)",
    );
  });

  it("posts an unsafe release for an encoded entry id", async () => {
    const fetchMock = stubFetch(
      createMockResponse({ status: 204 }),
      createMockResponse({ status: 409 }),
    );

    await releaseModelWorkEntry("entry/1");
    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE_URL}/app/model-work/entry%2F1/unsafe-release`,
      { method: "POST" },
    );
    await expect(releaseModelWorkEntry("entry-2")).rejects.toThrow(
      "Failed to release the entry (409)",
    );
  });
});

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  readonly close = vi.fn(() => {
    this.readyState = FakeWebSocket.CLOSED;
  });

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  drop() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

describe("ModelWorkWebSocket", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("connects once, relays parsed messages and reports connection changes", () => {
    const socket = new ModelWorkWebSocket();
    const onMessage = vi.fn();
    const onConnection = vi.fn();
    socket.onMessage(onMessage);
    socket.onConnectionChange(onConnection);

    socket.connect();
    socket.connect();
    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws = FakeWebSocket.instances[0];
    expect(ws.url).toBe(
      `ws://${window.location.host}${API_BASE_URL}/app/model-work/ws`,
    );
    expect(socket.isConnected).toBe(false);

    ws.open();
    expect(socket.isConnected).toBe(true);
    expect(onConnection).toHaveBeenCalledWith("connected");
    socket.connect();
    expect(FakeWebSocket.instances).toHaveLength(1);

    ws.onmessage?.({ data: new ArrayBuffer(1) });
    ws.onmessage?.({ data: "garbage" });
    expect(onMessage).not.toHaveBeenCalled();
    ws.onmessage?.({
      data: JSON.stringify({ type: "snapshot", data: { revision: 7 } }),
    });
    expect(onMessage).toHaveBeenCalledWith({
      type: "snapshot",
      data: { revision: 7 },
    });
  });

  it("reconnects after an unexpected close until disconnected", () => {
    const socket = new ModelWorkWebSocket();
    const onConnection = vi.fn();
    const unsubscribe = socket.onConnectionChange(onConnection);
    socket.connect();
    FakeWebSocket.instances[0].open();

    FakeWebSocket.instances[0].drop();
    expect(onConnection).toHaveBeenLastCalledWith("disconnected");
    expect(socket.isConnected).toBe(false);
    vi.advanceTimersByTime(3000);
    expect(FakeWebSocket.instances).toHaveLength(2);

    FakeWebSocket.instances[1].open();
    socket.disconnect();
    expect(FakeWebSocket.instances[1].close).toHaveBeenCalled();
    FakeWebSocket.instances[1].onclose?.();
    vi.advanceTimersByTime(10_000);
    expect(FakeWebSocket.instances).toHaveLength(2);

    unsubscribe();
    socket.connect();
    FakeWebSocket.instances[2].open();
    expect(onConnection).toHaveBeenCalledTimes(4);
  });

  it("cancels a pending retry when a stale socket opens", () => {
    const socket = new ModelWorkWebSocket();
    socket.connect();
    const first = FakeWebSocket.instances[0];
    first.drop();
    first.open();
    vi.advanceTimersByTime(3000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("stops relaying to unsubscribed message handlers", () => {
    const socket = new ModelWorkWebSocket();
    const onMessage = vi.fn();
    const unsubscribe = socket.onMessage(onMessage);
    socket.connect();
    unsubscribe();
    FakeWebSocket.instances[0].onmessage?.({
      data: JSON.stringify({ type: "event", data: { revision: 1 } }),
    });
    expect(onMessage).not.toHaveBeenCalled();
  });
});
