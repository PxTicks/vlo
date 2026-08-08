import type { ShellDisposable } from "./hostMenuCatalog";

export type ShellNotificationTone = "info" | "success" | "warning" | "error";

/**
 * Two kinds, because they answer different questions. A `toast` says something
 * happened and disappears; a `task` says something *is happening* and stays
 * until it settles, which is what long-running work needs.
 */
export type ShellNotificationKind = "toast" | "task";

export interface ShellNotificationEntry {
  readonly id: string;
  readonly kind: ShellNotificationKind;
  readonly tone: ShellNotificationTone;
  /** Present on tasks; toasts carry their whole text in `message`. */
  readonly title: string | null;
  readonly message: string;
  /** 0 to 1 on a determinate task; null on a toast or an indeterminate task. */
  readonly progress: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Who posted it. Extension entries carry the owning package's ID. */
  readonly source: "host" | "extension";
  readonly ownerId: string | null;
  /** Whether the entry offers a cancel affordance. */
  readonly cancellable: boolean;
}

export interface ShellToastRequest {
  readonly message: string;
  readonly tone?: ShellNotificationTone;
  /** Auto-dismiss delay. `0` keeps the toast until it is dismissed. */
  readonly durationMs?: number;
  readonly ownerId?: string | null;
}

export interface ShellTaskRequest {
  readonly title: string;
  readonly message?: string;
  /** 0 to 1. Omit for an indeterminate task. */
  readonly progress?: number;
  readonly tone?: ShellNotificationTone;
  readonly onCancel?: () => void;
  readonly ownerId?: string | null;
}

export interface ShellTaskUpdate {
  readonly message?: string;
  /** 0 to 1, or `null` to go back to indeterminate. Omit to leave unchanged. */
  readonly progress?: number | null;
  readonly tone?: ShellNotificationTone;
}

export interface ShellTaskSettleRequest {
  /** Leaves a final toast. Omit the whole request to settle silently. */
  readonly message?: string;
  readonly tone?: ShellNotificationTone;
  readonly durationMs?: number;
}

export interface ShellNotificationHandle extends ShellDisposable {
  readonly id: string;
}

export interface ShellTaskHandle extends ShellNotificationHandle {
  update(update: ShellTaskUpdate): void;
  settle(result?: ShellTaskSettleRequest): void;
}

export const DEFAULT_TOAST_DURATION_MS = 6_000;
const MAX_ENTRIES = 50;
const MAX_MESSAGE_LENGTH = 500;
const MAX_TITLE_LENGTH = 120;
const TONES: readonly ShellNotificationTone[] = [
  "info",
  "success",
  "warning",
  "error",
];

function assertText(value: string, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new Error(`${label} must be at most ${maxLength} characters.`);
  }
  return normalized;
}

function assertTone(
  tone: ShellNotificationTone | undefined,
  fallback: ShellNotificationTone,
): ShellNotificationTone {
  if (tone === undefined) return fallback;
  if (!TONES.includes(tone)) {
    throw new Error(`Unsupported notification tone '${String(tone)}'.`);
  }
  return tone;
}

function assertDuration(durationMs: number | undefined): number {
  if (durationMs === undefined) return DEFAULT_TOAST_DURATION_MS;
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new Error("Notification durationMs must be zero or a positive number.");
  }
  return durationMs;
}

function assertProgress(progress: number | undefined | null): number | null {
  if (progress === undefined || progress === null) return null;
  if (!Number.isFinite(progress)) {
    throw new Error("Notification progress must be a finite number.");
  }
  return Math.max(0, Math.min(1, progress));
}

/**
 * Owner-neutral status surface: toasts and long-running task entries with
 * progress and an optional cancel. Host features and the extension adapter post
 * through the same table, so a background render, a stem separation, and a
 * third-party analysis all appear in one place instead of each growing a
 * bespoke snackbar.
 *
 * Auto-dismiss lives here rather than in the mount, so a toast expires whether
 * or not the notification UI happens to be rendered — a headless test and a
 * running editor observe the same entries.
 */
export class HostNotificationCenter {
  private readonly entries = new Map<string, ShellNotificationEntry>();
  private readonly cancels = new Map<string, () => void>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;
  private revision = 0;
  private sequence = 0;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  postToast(request: ShellToastRequest): ShellNotificationHandle {
    const message = assertText(request.message, "Notification message", MAX_MESSAGE_LENGTH);
    const tone = assertTone(request.tone, "info");
    const durationMs = assertDuration(request.durationMs);
    const id = this.nextId("toast");
    const timestamp = this.now();
    this.write({
      id,
      kind: "toast",
      tone,
      title: null,
      message,
      progress: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      source: request.ownerId ? "extension" : "host",
      ownerId: request.ownerId ?? null,
      cancellable: false,
    });
    this.scheduleDismiss(id, durationMs);
    return Object.freeze({ id, dispose: () => this.dismiss(id) });
  }

  startTask(request: ShellTaskRequest): ShellTaskHandle {
    const title = assertText(request.title, "Task title", MAX_TITLE_LENGTH);
    const message =
      request.message === undefined
        ? ""
        : assertText(request.message, "Task message", MAX_MESSAGE_LENGTH);
    const tone = assertTone(request.tone, "info");
    const progress = assertProgress(request.progress);
    if (request.onCancel !== undefined && typeof request.onCancel !== "function") {
      throw new TypeError("Task onCancel must be a function.");
    }
    const id = this.nextId("task");
    const timestamp = this.now();
    this.write({
      id,
      kind: "task",
      tone,
      title,
      message,
      progress,
      createdAt: timestamp,
      updatedAt: timestamp,
      source: request.ownerId ? "extension" : "host",
      ownerId: request.ownerId ?? null,
      cancellable: request.onCancel !== undefined,
    });
    if (request.onCancel) this.cancels.set(id, request.onCancel);

    let settled = false;
    const finish = (result?: ShellTaskSettleRequest): void => {
      if (settled) return;
      settled = true;
      const current = this.entries.get(id);
      // Owner cleanup and manual dismissal invalidate the handle. In
      // particular, a retained extension handle must not be able to recreate a
      // notification after deactivation cleared everything it owned.
      if (!current) return;
      const ownerId = current.ownerId;
      this.dismiss(id);
      if (result?.message === undefined) return;
      this.postToast({
        message: result.message,
        tone: result.tone ?? "success",
        ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
        ownerId,
      });
    };

    return Object.freeze({
      id,
      update: (update: ShellTaskUpdate) => {
        if (settled) return;
        const current = this.entries.get(id);
        if (!current) return;
        this.write({
          ...current,
          message:
            update.message === undefined
              ? current.message
              : assertText(update.message, "Task message", MAX_MESSAGE_LENGTH),
          progress:
            update.progress === undefined
              ? current.progress
              : assertProgress(update.progress),
          tone: assertTone(update.tone, current.tone),
          updatedAt: this.now(),
        });
      },
      settle: finish,
      dispose: () => finish(),
    });
  }

  list(): readonly ShellNotificationEntry[] {
    return [...this.entries.values()];
  }

  listByOwner(ownerId: string): readonly ShellNotificationEntry[] {
    return this.list().filter((entry) => entry.ownerId === ownerId);
  }

  dismiss(id: string): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    this.cancels.delete(id);
    if (!this.entries.delete(id)) return;
    this.emitChange();
  }

  /**
   * Invokes the entry's cancel callback. The entry stays until its owner
   * settles it: cancelling asks the work to stop, and only the work knows when
   * it has.
   */
  cancel(id: string): boolean {
    const onCancel = this.cancels.get(id);
    if (!onCancel) return false;
    try {
      onCancel();
    } catch (error) {
      console.warn("Notification cancel handler failed", error);
    }
    return true;
  }

  /** Removes every entry one owner posted; used when an extension goes away. */
  clearOwner(ownerId: string): void {
    for (const entry of this.listByOwner(ownerId)) this.dismiss(entry.id);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getRevision(): number {
    return this.revision;
  }

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${this.sequence}`;
  }

  private write(entry: ShellNotificationEntry): void {
    this.entries.set(entry.id, Object.freeze(entry));
    // Drop the oldest settled-ish entries first. Tasks are load-bearing while
    // they run, so an overflowing centre sheds toasts before it sheds work.
    while (this.entries.size > MAX_ENTRIES) {
      const victim =
        this.list().find((candidate) => candidate.kind === "toast") ??
        this.list()[0];
      if (!victim) break;
      this.entries.delete(victim.id);
      this.cancels.delete(victim.id);
      const timer = this.timers.get(victim.id);
      if (timer !== undefined) {
        clearTimeout(timer);
        this.timers.delete(victim.id);
      }
    }
    this.emitChange();
  }

  private scheduleDismiss(id: string, durationMs: number): void {
    // An overflowing centre may shed the newly-posted toast in preference to
    // evicting a running task. Do not leave a timer behind for an absent entry.
    if (durationMs <= 0 || !this.entries.has(id)) return;
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        this.dismiss(id);
      }, durationMs),
    );
  }

  private emitChange(): void {
    this.revision += 1;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // Notification observers are derived render notifications only.
      }
    }
  }
}

export const hostNotificationCenter = new HostNotificationCenter();

/** Convenience for host features that only need a one-line confirmation. */
export function postHostToast(
  message: string,
  tone: ShellNotificationTone = "info",
  durationMs?: number,
): ShellNotificationHandle {
  return hostNotificationCenter.postToast({
    message,
    tone,
    ...(durationMs === undefined ? {} : { durationMs }),
  });
}
