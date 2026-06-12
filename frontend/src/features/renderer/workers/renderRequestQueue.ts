interface ClipScopedRenderRequest {
  clipId: string;
}

export interface RenderRequestQueueState<
  TRequest extends ClipScopedRenderRequest,
> {
  activeClipIds: ReadonlySet<string>;
  pendingByClipId: ReadonlyMap<string, TRequest>;
}

export interface EnqueueRenderRequestResult<
  TRequest extends ClipScopedRenderRequest,
> {
  displacedRequest: TRequest | null;
  queueState: RenderRequestQueueState<TRequest>;
  shouldStart: boolean;
}

export interface CompleteRenderRequestResult<
  TRequest extends ClipScopedRenderRequest,
> {
  nextRequest: TRequest | null;
  queueState: RenderRequestQueueState<TRequest>;
}

export interface ClearPendingRenderRequestResult<
  TRequest extends ClipScopedRenderRequest,
> {
  clearedRequest: TRequest | null;
  queueState: RenderRequestQueueState<TRequest>;
}

export function createRenderRequestQueueState<
  TRequest extends ClipScopedRenderRequest,
>(): RenderRequestQueueState<TRequest> {
  return {
    activeClipIds: new Set<string>(),
    pendingByClipId: new Map<string, TRequest>(),
  };
}

export function enqueueRenderRequest<
  TRequest extends ClipScopedRenderRequest,
>(
  queueState: RenderRequestQueueState<TRequest>,
  request: TRequest,
): EnqueueRenderRequestResult<TRequest> {
  if (queueState.activeClipIds.has(request.clipId)) {
    const pendingByClipId = new Map(queueState.pendingByClipId);
    const displacedRequest = pendingByClipId.get(request.clipId) ?? null;
    pendingByClipId.set(request.clipId, request);
    return {
      displacedRequest,
      queueState: {
        activeClipIds: queueState.activeClipIds,
        pendingByClipId,
      },
      shouldStart: false,
    };
  }

  const activeClipIds = new Set(queueState.activeClipIds);
  activeClipIds.add(request.clipId);
  return {
    displacedRequest: null,
    queueState: {
      activeClipIds,
      pendingByClipId: queueState.pendingByClipId,
    },
    shouldStart: true,
  };
}

export function completeRenderRequest<
  TRequest extends ClipScopedRenderRequest,
>(
  queueState: RenderRequestQueueState<TRequest>,
  clipId: string,
): CompleteRenderRequestResult<TRequest> {
  const pendingRequest = queueState.pendingByClipId.get(clipId) ?? null;
  const activeClipIds = new Set(queueState.activeClipIds);
  const pendingByClipId = new Map(queueState.pendingByClipId);
  pendingByClipId.delete(clipId);

  if (pendingRequest) {
    return {
      nextRequest: pendingRequest,
      queueState: {
        activeClipIds,
        pendingByClipId,
      },
    };
  }

  activeClipIds.delete(clipId);
  return {
    nextRequest: null,
    queueState: {
      activeClipIds,
      pendingByClipId,
    },
  };
}

export function clearPendingRenderRequest<
  TRequest extends ClipScopedRenderRequest,
>(
  queueState: RenderRequestQueueState<TRequest>,
  clipId: string,
): ClearPendingRenderRequestResult<TRequest> {
  const clearedRequest = queueState.pendingByClipId.get(clipId) ?? null;
  if (!clearedRequest) {
    return { clearedRequest: null, queueState };
  }

  const pendingByClipId = new Map(queueState.pendingByClipId);
  pendingByClipId.delete(clipId);
  return {
    clearedRequest,
    queueState: {
      activeClipIds: queueState.activeClipIds,
      pendingByClipId,
    },
  };
}
