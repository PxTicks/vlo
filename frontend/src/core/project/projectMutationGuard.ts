/**
 * Freezes the project while a whole-project export renders.
 *
 * The export renders in this tab and reads live state as it goes (the asset
 * store, live parameter overrides), so an edit that lands mid-render can leak
 * into the output, and a deleted asset can fail it. The export controller
 * holds the one lease; every path that changes the project checks it.
 *
 * Borrowed from `headless_render`, where a backend held the lease and read
 * the project from disk. What that needed and this does not is left out: the
 * file-write seal (the in-tab render reads memory, and everything that
 * changes an asset's bytes is already a guarded mutation, so a seal would only
 * hold back saving the user's last edits for the length of the export), the
 * handshake exemption, and restoring a hold another tab owns.
 */
export class ProjectMutationBlockedError extends Error {
  constructor(message = "Editing is paused while this project is being exported.") {
    super(message);
    this.name = "ProjectMutationBlockedError";
  }
}

export interface ProjectExportLease {
  /** Only the export that acquired the lease may end it; a stale owner is ignored. */
  release(): void;
}

interface PendingAcquire {
  settle: () => void;
}

function createAbortError(): Error {
  const error = new Error("Export cancelled");
  error.name = "AbortError";
  return error;
}

export class ProjectMutationGuard {
  private lease: object | null = null;
  private mutations = 0;
  private pendingAcquire: PendingAcquire | null = null;
  private readonly unfreezeWaiters = new Set<() => void>();
  private readonly editBlockers = new Set<() => string | null>();
  private readonly freezeListeners = new Set<() => void>();

  /**
   * An edit the user is still in the middle of (a drag, an open spline or
   * transform session) that an export must not start behind. It is refused,
   * never committed or cleared on the user's behalf.
   */
  registerEditBlocker(blocker: () => string | null): () => void {
    this.editBlockers.add(blocker);
    return () => { this.editBlockers.delete(blocker); };
  }

  /**
   * Calls `listener` each time an export freezes the project. For background
   * work that is not a mutation, so an export does not wait for it, but that
   * should stand aside once one starts (a proxy transcode wants the encoder).
   */
  onFreeze(listener: () => void): () => void {
    this.freezeListeners.add(listener);
    return () => { this.freezeListeners.delete(listener); };
  }

  isFrozen(): boolean {
    return this.lease !== null;
  }

  assertEditable(): void {
    if (this.lease) throw new ProjectMutationBlockedError();
  }

  /**
   * Refuses an export that cannot start: one is already running or waiting,
   * or the user is mid-edit. Checked before the export does any work of its
   * own, so an unfinished drag costs nothing but the message.
   */
  assertQuiescent(): void {
    if (this.lease || this.pendingAcquire) throw new ProjectMutationBlockedError();
    const message = this.blockerMessage();
    if (message) throw new ProjectMutationBlockedError(message);
  }

  private blockerMessage(): string | null {
    for (const blocker of this.editBlockers) {
      const message = blocker();
      if (message) return message;
    }
    return null;
  }

  /**
   * Freezes the project for an export.
   *
   * A change already in flight is finished rather than refused or cut off:
   * the lease is installed at the moment the last one settles, synchronously,
   * so nothing can start in between. Changes that begin while this waits are
   * admitted too, because refusing them would strand the multi-step ones
   * (a subtimeline publish awaits between its commits) half-applied.
   */
  acquire(options: { signal?: AbortSignal } = {}): Promise<ProjectExportLease> {
    const { signal } = options;
    try {
      this.assertQuiescent();
      if (signal?.aborted) throw signal.reason ?? createAbortError();
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.mutations === 0) return Promise.resolve(this.installLease());

    return new Promise<ProjectExportLease>((resolve, reject) => {
      const onAbort = () => {
        if (this.pendingAcquire !== pending) return;
        this.pendingAcquire = null;
        reject(signal?.reason ?? createAbortError());
      };
      const pending: PendingAcquire = {
        settle: () => {
          signal?.removeEventListener("abort", onAbort);
          // A session that opened while this waited was not refused, so it
          // is checked again rather than frozen mid-edit.
          const message = this.blockerMessage();
          if (message) {
            reject(new ProjectMutationBlockedError(message));
            return;
          }
          resolve(this.installLease());
        },
      };
      this.pendingAcquire = pending;
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private installLease(): ProjectExportLease {
    const lease = {};
    this.lease = lease;
    for (const listener of [...this.freezeListeners]) {
      // A listener that throws must not fail the export that froze.
      try {
        listener();
      } catch (error) {
        console.error("Failed to notify work of a project freeze", error);
      }
    }
    return {
      release: () => {
        if (this.lease !== lease) return;
        this.lease = null;
        this.resumeDeferred();
      },
    };
  }

  /**
   * Counts a change for as long as it runs, including its awaits, so an
   * export waits for it instead of freezing the project partway through.
   */
  beginMutation(): () => void {
    this.assertEditable();
    this.mutations += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.mutations -= 1;
      if (this.mutations === 0 && this.pendingAcquire) {
        const pending = this.pendingAcquire;
        this.pendingAcquire = null;
        pending.settle();
      }
    };
  }

  /** Runs `run` once no export holds the project, or now when none does. */
  whenUnfrozen(run: () => void): void {
    if (!this.lease) {
      run();
      return;
    }
    this.unfreezeWaiters.add(run);
  }

  untilUnfrozen(): Promise<void> {
    return new Promise((resolve) => { this.whenUnfrozen(resolve); });
  }

  private resumeDeferred(): void {
    const resuming = [...this.unfreezeWaiters];
    this.unfreezeWaiters.clear();
    for (const resume of resuming) {
      // One waiter that cannot resume must not strand the others.
      try {
        resume();
      } catch (error) {
        console.error("Failed to resume work deferred by an export", error);
      }
    }
  }
}

export const projectMutationGuard = new ProjectMutationGuard();

/** Distinguishes "the project is frozen, try later" from a failed change. */
export function isProjectMutationBlockedError(error: unknown): error is ProjectMutationBlockedError {
  return error instanceof ProjectMutationBlockedError;
}

/**
 * Refuses the change while an export holds the project, and otherwise counts
 * it for its whole asynchronous run, including rollback.
 */
export function guardProjectMutation<Args extends unknown[], Result>(
  mutate: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  return async (...args) => {
    const release = projectMutationGuard.beginMutation();
    try {
      return await mutate(...args);
    } finally {
      release();
    }
  };
}

/**
 * Holds the change until no export holds the project, then counts it like
 * {@link guardProjectMutation}. For work that arrives on its own, such as a
 * finished generation being imported: refusing it would lose the result, and
 * nothing would bring it back.
 */
export function deferProjectMutation<Args extends unknown[], Result>(
  mutate: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  return async (...args) => {
    // Checked before any await, so with no export running the change starts
    // in the same turn, as it would unwrapped. After a wait, another export
    // may have started before this continuation ran; wait for that one too.
    while (projectMutationGuard.isFrozen()) {
      await projectMutationGuard.untilUnfrozen();
    }
    const release = projectMutationGuard.beginMutation();
    try {
      return await mutate(...args);
    } finally {
      release();
    }
  };
}
