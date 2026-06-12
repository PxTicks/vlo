import DecoderWorker from "../workers/decoder.worker?worker";
import {
  DECODER_WORKER_STARTUP_GRACE_MS,
  canResetDecoderWorker,
} from "../utils/decoderWorkerRecovery";
import {
  createDecoderRequestDiagnostics,
  isDecoderDiagnosticMessage,
  isDecoderWorkerHealthMessage,
  logDecoderDiagnostic,
  logDecoderWorkerPhase,
  type DecoderDiagnosticSource,
  type DecoderRequestDiagnostics,
} from "../utils/decoderDiagnostics";

type DecoderSourceKind = "video" | "image" | "mask_video";

type WorkerReadyMessage = {
  type: "ready";
  clipId: string;
  kind: DecoderSourceKind;
};

type WorkerFrameMessage = {
  type: "frame";
  clipId: string;
  bitmap: ImageBitmap | null;
  time: number;
  transformTime?: number;
  requestId?: string;
  error?: string;
};

type WorkerErrorMessage = {
  type: "error";
  message?: string;
};

type DecoderWorkerMessage =
  | WorkerReadyMessage
  | WorkerFrameMessage
  | WorkerErrorMessage;

export type DecoderStallResolution =
  | "renderer-reset"
  | "worker-replaced"
  | "throttled"
  | "released";

export interface DecoderLeaseEvents {
  onReady(clipId: string, kind: DecoderSourceKind): void;
  onFrame(message: {
    clipId: string;
    bitmap: ImageBitmap | null;
    time: number;
    transformTime?: number;
    requestId?: string;
    error?: string;
  }): void;
  onWorkerError(error: Error): void;
  onSourceEvicted(clipId: string): void;
}

export interface DecoderLease {
  prepare(request: {
    clipId: string;
    url: string;
    kind: DecoderSourceKind;
    file?: File;
    width?: number;
    height?: number;
    fit?: "contain" | "cover" | "fill";
    diagnostics?: DecoderRequestDiagnostics;
  }): void;
  render(request: {
    clipId: string;
    time: number;
    transformTime?: number;
    strict?: boolean;
    requestId?: string;
    diagnostics?: DecoderRequestDiagnostics;
  }): void;
  disposeSource(clipId: string): void;
  reportStall(clipId: string, reason: string): Promise<DecoderStallResolution>;
  release(): void;
}

export interface DecoderWorkerPool {
  warmUp(): void;
  acquireLease(
    meta: { label?: string } | undefined,
    events: DecoderLeaseEvents,
  ): DecoderLease;
  dispose(): void;
}

interface LeaseRecord {
  id: string;
  label?: string;
  released: boolean;
  events: DecoderLeaseEvents;
  assignmentsByClipId: Map<string, SourceAssignment>;
}

interface SourceAssignment {
  clipId: string;
  key: string;
  lease: LeaseRecord;
  workerRecord: WorkerRecord;
}

interface WorkerPingState {
  diagnostics: DecoderRequestDiagnostics | undefined;
  pingId: string;
  promise: Promise<"pong" | "timeout">;
  resolve: (result: "pong" | "timeout") => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

interface WorkerRecord {
  assignedKeys: Map<string, SourceAssignment>;
  booted: boolean;
  createdAtMs: number;
  disposed: boolean;
  id: string;
  lastMessageAtMs: number;
  pingState: WorkerPingState | null;
  recentlyRenderedKeys: Map<string, number>;
  replacementPromise: Promise<boolean> | null;
  responsive: boolean;
  worker: Worker;
}

const LIVE_POOL_MIN_SIZE = 2;
const LIVE_POOL_MAX_SIZE = 4;
const EXPORT_POOL_MIN_SIZE = 2;
const EXPORT_POOL_MAX_SIZE = 6;
const DEFAULT_HARDWARE_CONCURRENCY = 4;
const WORKER_HEALTH_PING_TIMEOUT_MS = 1000;
const RENDERER_RESET_COOLDOWN_MS = 2000;
const ACTIVE_RENDER_WINDOW_MS = 3000;

let sharedDecoderWorkerPool: DecoderWorkerPoolImpl | null = null;

function clamp(min: number, max: number, value: number): number {
  return Math.max(min, Math.min(max, value));
}

function getHardwareConcurrency(): number {
  if (
    typeof navigator !== "undefined" &&
    typeof navigator.hardwareConcurrency === "number" &&
    Number.isFinite(navigator.hardwareConcurrency)
  ) {
    return navigator.hardwareConcurrency;
  }
  return DEFAULT_HARDWARE_CONCURRENCY;
}

function getConfiguredPoolSize(): number | null {
  const rawValue = Number(import.meta.env.VITE_DECODER_POOL_SIZE);
  if (!Number.isFinite(rawValue) || rawValue <= 0) {
    return null;
  }
  return Math.floor(rawValue);
}

function getDefaultPoolSize(label?: string): number {
  const configuredPoolSize = getConfiguredPoolSize();
  if (configuredPoolSize !== null) {
    return configuredPoolSize;
  }

  const hardwareConcurrency = getHardwareConcurrency();
  if (label === "export") {
    return clamp(
      EXPORT_POOL_MIN_SIZE,
      EXPORT_POOL_MAX_SIZE,
      hardwareConcurrency - 2,
    );
  }

  return clamp(
    LIVE_POOL_MIN_SIZE,
    LIVE_POOL_MAX_SIZE,
    Math.floor(hardwareConcurrency / 2),
  );
}

function closeBitmapIfPresent(bitmap: ImageBitmap | null | undefined): void {
  if (bitmap && typeof bitmap.close === "function") {
    bitmap.close();
  }
}

function createWorkerError(message: string): Error {
  return new Error(message);
}

class DecoderWorkerPoolImpl implements DecoderWorkerPool {
  private readonly label: string;
  private readonly targetSize: number;
  private disposed = false;
  private nextLeaseId = 0;
  private nextPingId = 0;
  private nextWorkerId = 0;
  private readonly lastRendererResetAtByKey = new Map<string, number>();
  private readonly leases = new Map<string, LeaseRecord>();
  private readonly workerRecords = new Set<WorkerRecord>();

  constructor(options: { label?: string; size?: number } = {}) {
    this.label = options.label ?? "shared";
    this.targetSize = Math.max(1, options.size ?? getDefaultPoolSize(options.label));
  }

  public warmUp(): void {
    if (this.disposed) {
      return;
    }

    while (this.workerRecords.size < this.targetSize) {
      this.spawnWorker();
    }
  }

  public acquireLease(
    meta: { label?: string } | undefined,
    events: DecoderLeaseEvents,
  ): DecoderLease {
    if (this.disposed) {
      throw new Error("Decoder worker pool has been disposed");
    }

    this.nextLeaseId += 1;
    const leaseRecord: LeaseRecord = {
      id: `lease-${this.nextLeaseId}`,
      label: meta?.label,
      released: false,
      events,
      assignmentsByClipId: new Map<string, SourceAssignment>(),
    };
    this.leases.set(leaseRecord.id, leaseRecord);

    return {
      prepare: (request) => {
        if (this.disposed || leaseRecord.released) {
          return;
        }

        const assignment = this.ensureAssignment(leaseRecord, request.clipId);
        assignment.workerRecord.worker.postMessage({
          type: "prepare",
          url: request.url,
          clipId: assignment.key,
          kind: request.kind,
          file: request.file,
          width: request.width,
          height: request.height,
          fit: request.fit,
          ...(request.diagnostics ? { diagnostics: request.diagnostics } : {}),
        });
      },
      render: (request) => {
        if (this.disposed || leaseRecord.released) {
          return;
        }

        const assignment = this.ensureAssignment(leaseRecord, request.clipId);
        assignment.workerRecord.recentlyRenderedKeys.set(
          assignment.key,
          performance.now(),
        );
        assignment.workerRecord.worker.postMessage({
          type: "render",
          time: request.time,
          clipId: assignment.key,
          transformTime: request.transformTime,
          strict: request.strict,
          requestId: request.requestId,
          ...(request.diagnostics ? { diagnostics: request.diagnostics } : {}),
        });
      },
      disposeSource: (clipId) => {
        if (this.disposed || leaseRecord.released) {
          return;
        }
        this.disposeAssignment(
          leaseRecord.assignmentsByClipId.get(clipId) ?? null,
          { sendDispose: true, notifyEvicted: false },
        );
      },
      reportStall: async (clipId, reason) => {
        return this.reportStall(leaseRecord, clipId, reason);
      },
      release: () => {
        if (leaseRecord.released) {
          return;
        }
        leaseRecord.released = true;
        for (const assignment of [...leaseRecord.assignmentsByClipId.values()]) {
          this.disposeAssignment(assignment, {
            sendDispose: true,
            notifyEvicted: false,
          });
        }
        this.leases.delete(leaseRecord.id);
      },
    };
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    for (const leaseRecord of this.leases.values()) {
      leaseRecord.released = true;
      leaseRecord.assignmentsByClipId.clear();
    }
    this.leases.clear();

    for (const workerRecord of [...this.workerRecords]) {
      this.terminateWorker(workerRecord, "pool disposed");
    }

    this.lastRendererResetAtByKey.clear();
  }

  private ensureAssignment(
    leaseRecord: LeaseRecord,
    clipId: string,
  ): SourceAssignment {
    const existingAssignment = leaseRecord.assignmentsByClipId.get(clipId);
    if (existingAssignment && !existingAssignment.workerRecord.disposed) {
      return existingAssignment;
    }

    const workerRecord = this.chooseWorkerForAssignment();
    const assignment: SourceAssignment = {
      clipId,
      key: this.namespaceClipId(leaseRecord.id, clipId),
      lease: leaseRecord,
      workerRecord,
    };

    leaseRecord.assignmentsByClipId.set(clipId, assignment);
    workerRecord.assignedKeys.set(assignment.key, assignment);
    this.logPoolEvent("main:pool:assign", assignment.key, {
      workerId: workerRecord.id,
      assignedCount: workerRecord.assignedKeys.size,
      activeCount: this.getActiveAssignmentCount(workerRecord),
      leaseLabel: leaseRecord.label,
    });
    this.maybeSpawnBackgroundWorker();
    return assignment;
  }

  private namespaceClipId(leaseId: string, clipId: string): string {
    return `${leaseId}/${clipId}`;
  }

  private chooseWorkerForAssignment(): WorkerRecord {
    const candidates = [...this.workerRecords].filter(
      (workerRecord) => !workerRecord.disposed,
    );
    if (candidates.length === 0) {
      return this.spawnWorker();
    }

    const availableWorkers = candidates.filter((workerRecord) =>
      this.isWorkerAvailable(workerRecord),
    );
    const pool = availableWorkers.length > 0 ? availableWorkers : candidates;
    pool.sort((left, right) => {
      const activeDelta =
        this.getActiveAssignmentCount(left) - this.getActiveAssignmentCount(right);
      if (activeDelta !== 0) {
        return activeDelta;
      }

      const assignedDelta = left.assignedKeys.size - right.assignedKeys.size;
      if (assignedDelta !== 0) {
        return assignedDelta;
      }

      return left.createdAtMs - right.createdAtMs;
    });
    return pool[0];
  }

  private maybeSpawnBackgroundWorker(): void {
    if (this.workerRecords.size >= this.targetSize) {
      return;
    }

    const availableWorkers = [...this.workerRecords].filter((workerRecord) =>
      this.isWorkerAvailable(workerRecord),
    );
    if (availableWorkers.length === 0) {
      return;
    }

    const allBusy = availableWorkers.every(
      (workerRecord) => workerRecord.assignedKeys.size >= 1,
    );
    if (allBusy) {
      this.spawnWorker();
    }
  }

  private spawnWorker(): WorkerRecord {
    this.nextWorkerId += 1;
    const workerId = `${this.label}-worker-${this.nextWorkerId}`;
    const worker = new DecoderWorker();
    const workerRecord: WorkerRecord = {
      assignedKeys: new Map<string, SourceAssignment>(),
      booted: false,
      createdAtMs: performance.now(),
      disposed: false,
      id: workerId,
      lastMessageAtMs: 0,
      pingState: null,
      recentlyRenderedKeys: new Map<string, number>(),
      replacementPromise: null,
      responsive: false,
      worker,
    };

    worker.onmessage = (event: MessageEvent) => {
      this.handleWorkerMessage(workerRecord, event);
    };
    worker.onerror = (event) => {
      this.handleWorkerProblem(workerRecord, "main:worker:error", {
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
      });
    };
    worker.onmessageerror = (event) => {
      this.handleWorkerProblem(workerRecord, "main:worker:messageerror", {
        dataType: typeof event.data,
      });
    };

    this.workerRecords.add(workerRecord);
    this.logPoolEvent("main:pool:spawn", workerId, {
      workerId,
      assignedCount: 0,
      activeCount: 0,
      targetSize: this.targetSize,
    });
    return workerRecord;
  }

  private handleWorkerMessage(
    workerRecord: WorkerRecord,
    event: MessageEvent,
  ): void {
    if (workerRecord.disposed) {
      return;
    }

    const message = event.data;
    workerRecord.lastMessageAtMs = performance.now();

    if (isDecoderDiagnosticMessage(message)) {
      logDecoderDiagnostic(message);
      return;
    }

    if (isDecoderWorkerHealthMessage(message)) {
      this.handleWorkerHealthMessage(workerRecord, message);
      return;
    }

    this.markWorkerResponsive(workerRecord);
    const typedMessage = message as DecoderWorkerMessage;

    if (typedMessage.type === "ready") {
      const assignment = workerRecord.assignedKeys.get(typedMessage.clipId);
      if (!assignment || assignment.lease.released) {
        return;
      }

      assignment.lease.events.onReady(assignment.clipId, typedMessage.kind);
      return;
    }

    if (typedMessage.type === "frame") {
      const assignment = workerRecord.assignedKeys.get(typedMessage.clipId);
      if (!assignment || assignment.lease.released) {
        closeBitmapIfPresent(typedMessage.bitmap);
        return;
      }

      workerRecord.recentlyRenderedKeys.set(
        typedMessage.clipId,
        performance.now(),
      );
      assignment.lease.events.onFrame({
        clipId: assignment.clipId,
        bitmap: typedMessage.bitmap,
        time: typedMessage.time,
        transformTime:
          typeof typedMessage.transformTime === "number"
            ? typedMessage.transformTime
            : undefined,
        requestId: typedMessage.requestId,
        error: typedMessage.error,
      });
      return;
    }

    if (typedMessage.type === "error") {
      this.broadcastWorkerError(
        workerRecord,
        createWorkerError(
          typedMessage.message ?? "Decoder worker error",
        ),
      );
    }
  }

  private handleWorkerHealthMessage(
    workerRecord: WorkerRecord,
    message: { pingId?: string; workerElapsedMs?: number; event: "boot" | "pong"; detail?: Record<string, unknown> },
  ): void {
    if (message.event === "boot") {
      workerRecord.booted = true;
      workerRecord.responsive = true;
      this.logPoolWorkerPhase(
        workerRecord,
        "worker:health:boot",
        message.detail,
        message.workerElapsedMs,
      );
      return;
    }

    workerRecord.responsive = true;
    const pingState = workerRecord.pingState;
    if (!pingState || pingState.pingId !== message.pingId) {
      return;
    }

    clearTimeout(pingState.timeoutHandle);
    logDecoderWorkerPhase(
      pingState.diagnostics,
      "worker:health:pong",
      {
        pingId: message.pingId,
        workerId: workerRecord.id,
        assignedCount: workerRecord.assignedKeys.size,
        activeCount: this.getActiveAssignmentCount(workerRecord),
        ...(message.detail ?? {}),
      },
      message.workerElapsedMs,
    );
    workerRecord.pingState = null;
    pingState.resolve("pong");
  }

  private handleWorkerProblem(
    workerRecord: WorkerRecord,
    phase: string,
    detail: Record<string, unknown>,
  ): void {
    this.logPoolWorkerPhase(workerRecord, phase, detail);
    this.broadcastWorkerError(
      workerRecord,
      createWorkerError(
        typeof detail.message === "string"
          ? detail.message
          : "Decoder worker problem",
      ),
    );
  }

  private broadcastWorkerError(
    workerRecord: WorkerRecord,
    error: Error,
  ): void {
    const notifiedLeases = new Set<LeaseRecord>();
    for (const assignment of workerRecord.assignedKeys.values()) {
      if (assignment.lease.released || notifiedLeases.has(assignment.lease)) {
        continue;
      }
      notifiedLeases.add(assignment.lease);
      assignment.lease.events.onWorkerError(error);
    }
  }

  private async reportStall(
    leaseRecord: LeaseRecord,
    clipId: string,
    reason: string,
  ): Promise<DecoderStallResolution> {
    if (this.disposed || leaseRecord.released) {
      return "released";
    }

    const assignment = leaseRecord.assignmentsByClipId.get(clipId) ?? null;
    if (!assignment) {
      return "renderer-reset";
    }

    const pingResult = await this.pingWorker(workerRecordOrThrow(assignment), {
      clipId: assignment.key,
      reason,
      diagnosticsSource: "pool",
    });
    if (this.disposed || leaseRecord.released) {
      return "released";
    }

    if (pingResult === "pong") {
      if (!this.canRendererResetAssignment(assignment.key)) {
        return "throttled";
      }

      this.disposeAssignment(assignment, {
        sendDispose: true,
        notifyEvicted: false,
      });
      return "renderer-reset";
    }

    const workerRecord = assignment.workerRecord;
    const workerAgeMs = performance.now() - workerRecord.createdAtMs;
    if (
      !workerRecord.responsive &&
      !workerRecord.booted &&
      workerAgeMs < DECODER_WORKER_STARTUP_GRACE_MS
    ) {
      return "throttled";
    }

    if (!canResetDecoderWorker()) {
      return "throttled";
    }

    const replaced = await this.replaceWorker(workerRecord, reason);
    if (this.disposed || leaseRecord.released) {
      return "released";
    }

    return replaced ? "worker-replaced" : "throttled";
  }

  private canRendererResetAssignment(key: string): boolean {
    const nowMs = performance.now();
    const lastResetAtMs = this.lastRendererResetAtByKey.get(key) ?? -Infinity;
    if (nowMs - lastResetAtMs < RENDERER_RESET_COOLDOWN_MS) {
      return false;
    }

    this.lastRendererResetAtByKey.set(key, nowMs);
    return true;
  }

  private async pingWorker(
    workerRecord: WorkerRecord,
    options: {
      clipId: string;
      reason: string;
      diagnosticsSource: DecoderDiagnosticSource;
    },
  ): Promise<"pong" | "timeout"> {
    if (workerRecord.disposed) {
      return "timeout";
    }

    if (workerRecord.pingState) {
      return workerRecord.pingState.promise;
    }

    this.nextPingId += 1;
    const pingId = `${workerRecord.id}:ping-${this.nextPingId}`;
    const diagnostics = createDecoderRequestDiagnostics({
      source: options.diagnosticsSource,
      requestType: "worker",
      clipId: options.clipId,
      label: this.label,
    });

    logDecoderWorkerPhase(diagnostics, "main:worker:ping:send", {
      reason: options.reason,
      pingId,
      workerId: workerRecord.id,
      assignedCount: workerRecord.assignedKeys.size,
      activeCount: this.getActiveAssignmentCount(workerRecord),
      timeoutMs: WORKER_HEALTH_PING_TIMEOUT_MS,
    });

    let resolvePing: ((result: "pong" | "timeout") => void) | null = null;
    const promise = new Promise<"pong" | "timeout">((resolve) => {
      resolvePing = resolve;
    });
    const timeoutHandle = setTimeout(() => {
      logDecoderWorkerPhase(diagnostics, "main:worker:ping:timeout", {
        reason: options.reason,
        pingId,
        workerId: workerRecord.id,
        assignedCount: workerRecord.assignedKeys.size,
        activeCount: this.getActiveAssignmentCount(workerRecord),
        timeoutMs: WORKER_HEALTH_PING_TIMEOUT_MS,
      });
      const pingState = workerRecord.pingState;
      if (pingState?.pingId === pingId) {
        workerRecord.pingState = null;
      }
      resolvePing?.("timeout");
    }, WORKER_HEALTH_PING_TIMEOUT_MS);

    workerRecord.pingState = {
      diagnostics,
      pingId,
      promise,
      resolve: (result) => {
        resolvePing?.(result);
      },
      timeoutHandle,
    };
    workerRecord.worker.postMessage({ type: "ping", pingId });
    return promise;
  }

  private async replaceWorker(
    workerRecord: WorkerRecord,
    reason: string,
  ): Promise<boolean> {
    if (workerRecord.disposed) {
      return false;
    }

    if (workerRecord.replacementPromise) {
      return workerRecord.replacementPromise;
    }

    workerRecord.replacementPromise = this.replaceWorkerInternal(
      workerRecord,
      reason,
    ).finally(() => {
      workerRecord.replacementPromise = null;
    });
    return workerRecord.replacementPromise;
  }

  private async replaceWorkerInternal(
    workerRecord: WorkerRecord,
    reason: string,
  ): Promise<boolean> {
    const replacement = this.spawnWorker();
    const readyResult = await this.pingWorker(replacement, {
      clipId: workerRecord.id,
      reason: `replacement for ${workerRecord.id}: ${reason}`,
      diagnosticsSource: "pool",
    });

    if (readyResult !== "pong") {
      this.terminateWorker(replacement, "replacement did not respond");
      return false;
    }

    this.logPoolEvent("main:pool:replace", workerRecord.id, {
      workerId: workerRecord.id,
      replacementWorkerId: replacement.id,
      reason,
      assignedCount: workerRecord.assignedKeys.size,
      activeCount: this.getActiveAssignmentCount(workerRecord),
    });

    const evictedAssignments = [...workerRecord.assignedKeys.values()];
    for (const assignment of evictedAssignments) {
      this.disposeAssignment(assignment, {
        sendDispose: false,
        notifyEvicted: true,
      });
    }

    this.terminateWorker(workerRecord, "worker replaced");
    return true;
  }

  private disposeAssignment(
    assignment: SourceAssignment | null,
    options: {
      sendDispose: boolean;
      notifyEvicted: boolean;
    },
  ): void {
    if (!assignment) {
      return;
    }

    const { workerRecord, lease, key, clipId } = assignment;
    lease.assignmentsByClipId.delete(clipId);
    workerRecord.assignedKeys.delete(key);
    workerRecord.recentlyRenderedKeys.delete(key);

    if (options.sendDispose && !workerRecord.disposed) {
      workerRecord.worker.postMessage({ type: "dispose", clipId: key });
    }

    if (options.notifyEvicted && !lease.released) {
      this.logPoolEvent("main:pool:evict", key, {
        workerId: workerRecord.id,
        assignedCount: workerRecord.assignedKeys.size,
        activeCount: this.getActiveAssignmentCount(workerRecord),
        leaseLabel: lease.label,
      });
      lease.events.onSourceEvicted(clipId);
    }
  }

  private terminateWorker(workerRecord: WorkerRecord, reason: string): void {
    if (workerRecord.disposed) {
      return;
    }

    workerRecord.disposed = true;
    this.workerRecords.delete(workerRecord);

    if (workerRecord.pingState) {
      clearTimeout(workerRecord.pingState.timeoutHandle);
      workerRecord.pingState.resolve("timeout");
      workerRecord.pingState = null;
    }

    workerRecord.worker.onmessage = null;
    workerRecord.worker.onerror = null;
    workerRecord.worker.onmessageerror = null;
    workerRecord.worker.terminate();

    this.logPoolWorkerPhase(workerRecord, "main:worker:terminated", {
      reason,
      workerId: workerRecord.id,
      assignedCount: workerRecord.assignedKeys.size,
      activeCount: this.getActiveAssignmentCount(workerRecord),
    });
  }

  private markWorkerResponsive(workerRecord: WorkerRecord): void {
    workerRecord.responsive = true;
  }

  private isWorkerAvailable(workerRecord: WorkerRecord): boolean {
    return workerRecord.responsive || workerRecord.booted;
  }

  private getActiveAssignmentCount(workerRecord: WorkerRecord): number {
    const nowMs = performance.now();
    let count = 0;
    for (const lastRenderedAtMs of workerRecord.recentlyRenderedKeys.values()) {
      if (nowMs - lastRenderedAtMs <= ACTIVE_RENDER_WINDOW_MS) {
        count += 1;
      }
    }
    return count;
  }

  private logPoolEvent(
    phase: string,
    clipId: string,
    detail?: Record<string, unknown>,
  ): void {
    const diagnostics = createDecoderRequestDiagnostics({
      source: "pool",
      requestType: "worker",
      clipId,
      label: this.label,
    });
    logDecoderWorkerPhase(diagnostics, phase, detail);
  }

  private logPoolWorkerPhase(
    workerRecord: WorkerRecord,
    phase: string,
    detail?: Record<string, unknown>,
    workerElapsedMs?: number,
  ): void {
    const diagnostics = createDecoderRequestDiagnostics({
      source: "pool",
      requestType: "worker",
      clipId: workerRecord.id,
      label: this.label,
    });
    logDecoderWorkerPhase(
      diagnostics,
      phase,
      {
        workerId: workerRecord.id,
        assignedCount: workerRecord.assignedKeys.size,
        activeCount: this.getActiveAssignmentCount(workerRecord),
        ...(detail ?? {}),
      },
      workerElapsedMs,
    );
  }
}

function workerRecordOrThrow(assignment: SourceAssignment): WorkerRecord {
  return assignment.workerRecord;
}

export function getSharedDecoderWorkerPool(): DecoderWorkerPool {
  if (!sharedDecoderWorkerPool) {
    sharedDecoderWorkerPool = new DecoderWorkerPoolImpl();
  }
  return sharedDecoderWorkerPool;
}

export function createDecoderWorkerPool(
  options: { label?: string; size?: number } = {},
): DecoderWorkerPool {
  return new DecoderWorkerPoolImpl(options);
}

export function resetSharedDecoderWorkerPoolForTests(): void {
  sharedDecoderWorkerPool?.dispose();
  sharedDecoderWorkerPool = null;
}
