// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../core/shell/notificationCenter", () => ({
  postHostToast: vi.fn(),
}));

import { postHostToast } from "../../../core/shell/notificationCenter";
import {
  selectActiveEntries,
  selectGpuTenant,
  selectIsSourceBusy,
  useModelWorkStore,
} from "../useModelWorkStore";
import type {
  ModelWorkEntry,
  ModelWorkEvent,
  ModelWorkSnapshot,
} from "../services/modelWorkApi";

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  url: string;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  emit(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

function entry(overrides: Partial<ModelWorkEntry> = {}): ModelWorkEntry {
  return {
    entryId: "entry-1",
    resource: "local-gpu",
    tenant: "backend-process",
    source: "sam2",
    owner: "vlo.sam2",
    label: "SAM2 mask video",
    jobStatus: "running",
    occupancy: "occupied",
    progress: null,
    message: null,
    submittedAt: 1,
    startedAt: 1,
    endedAt: null,
    parentOccupancyId: null,
    cancelEndpoint: null,
    promptId: null,
    suspectedStale: false,
    ...overrides,
  };
}

function snapshot(overrides: Partial<ModelWorkSnapshot> = {}): ModelWorkSnapshot {
  return {
    revision: 5,
    ready: true,
    entries: [entry()],
    resources: [
      {
        resource: "local-gpu",
        width: 1,
        tenant: "backend-process",
        occupancyId: "occ-1",
        holderCount: 1,
      },
    ],
    ...overrides,
  };
}

function event(overrides: Partial<ModelWorkEvent> = {}): ModelWorkEvent {
  return {
    revision: 6,
    kind: "updated",
    entry: entry({ occupancy: "released", jobStatus: "succeeded" }),
    resources: [
      {
        resource: "local-gpu",
        width: 1,
        tenant: null,
        occupancyId: null,
        holderCount: 0,
      },
    ],
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.mocked(postHostToast).mockClear();
  vi.stubGlobal("WebSocket", MockWebSocket);
  fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => snapshot(),
  }));
  vi.stubGlobal("fetch", fetchMock);
  useModelWorkStore.setState({
    ready: false,
    revision: 0,
    connection: "connecting",
    entries: [],
    resources: [],
    error: null,
  });
});

afterEach(() => {
  useModelWorkStore.getState().disconnect();
  vi.unstubAllGlobals();
});

function connectAndSnapshot(): MockWebSocket {
  useModelWorkStore.getState().connect();
  const socket = MockWebSocket.instances[0];
  socket.open();
  socket.emit({ type: "snapshot", data: snapshot() });
  return socket;
}

describe("useModelWorkStore", () => {
  it("adopts the snapshot the socket opens with", () => {
    connectAndSnapshot();

    const state = useModelWorkStore.getState();
    expect(state.ready).toBe(true);
    expect(state.revision).toBe(5);
    expect(selectActiveEntries(state).map((item) => item.label)).toEqual([
      "SAM2 mask video",
    ]);
    expect(selectGpuTenant(state)).toBe("backend-process");
    expect(selectIsSourceBusy(state, "sam2")).toBe(true);
  });

  it("applies contiguous events without re-fetching", () => {
    const socket = connectAndSnapshot();
    fetchMock.mockClear();

    socket.emit({ type: "event", data: event() });

    const state = useModelWorkStore.getState();
    expect(state.revision).toBe(6);
    expect(selectActiveEntries(state)).toEqual([]);
    expect(selectGpuTenant(state)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-snapshots when a revision gap proves an event was dropped", () => {
    const socket = connectAndSnapshot();
    fetchMock.mockClear();

    socket.emit({ type: "event", data: event({ revision: 9 }) });

    // The gap is the only signal that the ledger is now wrong, so the store
    // must refuse to apply the delta on top of stale state.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useModelWorkStore.getState().revision).toBe(5);
  });

  it("removes entries the coordinator pruned", () => {
    const socket = connectAndSnapshot();

    socket.emit({ type: "event", data: event({ kind: "removed" }) });

    expect(useModelWorkStore.getState().entries).toEqual([]);
  });

  it("raises one notification per terminal failure", () => {
    const socket = connectAndSnapshot();
    const failed = event({
      entry: entry({
        occupancy: "released",
        jobStatus: "failed",
        message: "CUDA out of memory",
      }),
    });

    socket.emit({ type: "event", data: failed });
    socket.emit({ type: "event", data: { ...failed, revision: 7 } });

    expect(postHostToast).toHaveBeenCalledTimes(1);
    expect(postHostToast).toHaveBeenCalledWith(
      "SAM2: CUDA out of memory failed",
      "error",
    );
  });

  it("does not let a slow refresh roll socket state backwards", async () => {
    const socket = connectAndSnapshot();
    const deferred: { resolve: (value: unknown) => void } = {
      resolve: () => undefined,
    };
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          deferred.resolve = resolve;
        }),
    );

    const pending = useModelWorkStore.getState().refresh();
    // The socket delivers newer truth while the GET is still in flight.
    socket.emit({ type: "snapshot", data: snapshot({ revision: 11 }) });
    deferred.resolve({ ok: true, json: async () => snapshot({ revision: 10 }) });
    await pending;

    expect(useModelWorkStore.getState().revision).toBe(11);
  });

  it("re-snapshots from the socket after a backend restart resets revisions", () => {
    const socket = connectAndSnapshot();

    // A restarted coordinator legitimately counts from zero again, so socket
    // snapshots stay authoritative regardless of revision.
    socket.emit({
      type: "snapshot",
      data: snapshot({ revision: 1, entries: [] }),
    });

    const state = useModelWorkStore.getState();
    expect(state.revision).toBe(1);
    expect(state.entries).toEqual([]);
  });

  it("reports a cancelled job that is still resident as active", () => {
    const socket = connectAndSnapshot();

    socket.emit({
      type: "event",
      data: event({
        entry: entry({ jobStatus: "cancelled", occupancy: "stopping" }),
      }),
    });

    const state = useModelWorkStore.getState();
    // Independent fields: publicly cancelled, physically still on the GPU.
    expect(selectActiveEntries(state)).toHaveLength(1);
    expect(selectGpuTenant(state)).toBeNull();
  });
});
