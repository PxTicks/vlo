import { describe, expect, it } from "vitest";
import {
  clearPendingRenderRequest,
  completeRenderRequest,
  createRenderRequestQueueState,
  enqueueRenderRequest,
} from "../renderRequestQueue";

interface MockRenderRequest {
  clipId: string;
  requestId: string;
}

function createRequest(
  clipId: string,
  requestId: string,
): MockRenderRequest {
  return { clipId, requestId };
}

describe("renderRequestQueue", () => {
  it("keeps latest-wins coalescing scoped to a single clip", () => {
    let queueState = createRenderRequestQueueState<MockRenderRequest>();

    const firstRequest = createRequest("clip-a", "req-1");
    const secondRequest = createRequest("clip-a", "req-2");
    const thirdRequest = createRequest("clip-a", "req-3");

    const firstEnqueue = enqueueRenderRequest(queueState, firstRequest);
    queueState = firstEnqueue.queueState;
    expect(firstEnqueue.shouldStart).toBe(true);
    expect(firstEnqueue.displacedRequest).toBeNull();
    expect(queueState.activeClipIds.has("clip-a")).toBe(true);

    const secondEnqueue = enqueueRenderRequest(queueState, secondRequest);
    queueState = secondEnqueue.queueState;
    expect(secondEnqueue.shouldStart).toBe(false);
    expect(secondEnqueue.displacedRequest).toBeNull();
    expect(queueState.pendingByClipId.get("clip-a")).toEqual(secondRequest);

    const thirdEnqueue = enqueueRenderRequest(queueState, thirdRequest);
    queueState = thirdEnqueue.queueState;
    expect(thirdEnqueue.shouldStart).toBe(false);
    expect(thirdEnqueue.displacedRequest).toEqual(secondRequest);
    expect(queueState.pendingByClipId.get("clip-a")).toEqual(thirdRequest);

    const firstCompletion = completeRenderRequest(queueState, "clip-a");
    queueState = firstCompletion.queueState;
    expect(firstCompletion.nextRequest).toEqual(thirdRequest);
    expect(queueState.activeClipIds.has("clip-a")).toBe(true);
    expect(queueState.pendingByClipId.has("clip-a")).toBe(false);

    const secondCompletion = completeRenderRequest(queueState, "clip-a");
    queueState = secondCompletion.queueState;
    expect(secondCompletion.nextRequest).toBeNull();
    expect(queueState.activeClipIds.has("clip-a")).toBe(false);
  });

  it("allows different clips to render concurrently without stomping each other", () => {
    let queueState = createRenderRequestQueueState<MockRenderRequest>();

    const clipAFirst = createRequest("clip-a", "req-a1");
    const clipBFirst = createRequest("clip-b", "req-b1");
    const clipASecond = createRequest("clip-a", "req-a2");

    queueState = enqueueRenderRequest(queueState, clipAFirst).queueState;

    const clipBEnqueue = enqueueRenderRequest(queueState, clipBFirst);
    queueState = clipBEnqueue.queueState;
    expect(clipBEnqueue.shouldStart).toBe(true);
    expect(clipBEnqueue.displacedRequest).toBeNull();
    expect(queueState.activeClipIds.has("clip-a")).toBe(true);
    expect(queueState.activeClipIds.has("clip-b")).toBe(true);

    queueState = enqueueRenderRequest(queueState, clipASecond).queueState;
    expect(queueState.pendingByClipId.get("clip-a")).toEqual(clipASecond);
    expect(queueState.pendingByClipId.has("clip-b")).toBe(false);

    const clipBCompletion = completeRenderRequest(queueState, "clip-b");
    queueState = clipBCompletion.queueState;
    expect(clipBCompletion.nextRequest).toBeNull();
    expect(queueState.activeClipIds.has("clip-b")).toBe(false);
    expect(queueState.activeClipIds.has("clip-a")).toBe(true);

    const clipACompletion = completeRenderRequest(queueState, "clip-a");
    expect(clipACompletion.nextRequest).toEqual(clipASecond);
  });

  it("clears only the pending request for a disposed clip", () => {
    let queueState = createRenderRequestQueueState<MockRenderRequest>();

    const activeRequest = createRequest("clip-a", "req-1");
    const queuedRequest = createRequest("clip-a", "req-2");

    queueState = enqueueRenderRequest(queueState, activeRequest).queueState;
    queueState = enqueueRenderRequest(queueState, queuedRequest).queueState;

    const cleared = clearPendingRenderRequest(queueState, "clip-a");
    queueState = cleared.queueState;
    expect(cleared.clearedRequest).toEqual(queuedRequest);
    expect(queueState.activeClipIds.has("clip-a")).toBe(true);
    expect(queueState.pendingByClipId.has("clip-a")).toBe(false);

    const completion = completeRenderRequest(queueState, "clip-a");
    expect(completion.nextRequest).toBeNull();
    expect(completion.queueState.activeClipIds.has("clip-a")).toBe(false);
  });
});
