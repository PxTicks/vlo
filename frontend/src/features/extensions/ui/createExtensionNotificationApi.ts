import type {
  ExtensionApiScope,
  ExtensionDisposable,
  ExtensionNotificationApi,
  ExtensionNotificationHandle,
  ExtensionTaskHandle,
  ExtensionTaskRequest,
  ExtensionTaskSettleRequest,
  ExtensionTaskUpdate,
  ExtensionToastRequest,
} from "../types";
import {
  hostNotificationCenter,
  type HostNotificationCenter,
} from "../../../core/shell/notificationCenter";

/**
 * Concurrent live entries one extension may hold. High enough that no honest
 * package meets it, low enough that a loop posting one per frame is stopped
 * before it buries the editor.
 */
export const MAX_LIVE_NOTIFICATIONS_PER_EXTENSION = 16;

/**
 * Owner-scoped `api.ui.notifications` facade over the shell notification
 * centre. The centre owns entries, validation, auto-dismiss, and cancellation
 * dispatch; the adapter adds owner attribution, the per-extension entry cap,
 * cancel-callback isolation, and removal of everything this extension posted
 * when it deactivates.
 */
export function createExtensionNotificationApi(
  scope: ExtensionApiScope,
  center: HostNotificationCenter = hostNotificationCenter,
): ExtensionNotificationApi {
  const ownerId = scope.extension.id;
  let ownedCleanup: ExtensionDisposable | null = null;

  // Registered on first use so a package that never notifies adds no disposal
  // work, and re-registered after teardown so a later post is still owned.
  const ensureOwned = (): void => {
    if (ownedCleanup !== null) return;
    ownedCleanup = scope.own({
      dispose: () => {
        ownedCleanup = null;
        center.clearOwner(ownerId);
      },
    });
  };

  const beginEntry = (): void => {
    if (scope.signal.aborted) {
      throw new Error(`Extension '${ownerId}' can no longer post notifications.`);
    }
    // Counted against the centre rather than a local set, so auto-dismissed
    // toasts free their slot without the adapter tracking timers.
    if (center.listByOwner(ownerId).length >= MAX_LIVE_NOTIFICATIONS_PER_EXTENSION) {
      throw new Error(
        `Extension '${ownerId}' may hold at most ` +
          `${MAX_LIVE_NOTIFICATIONS_PER_EXTENSION} live notifications.`,
      );
    }
    ensureOwned();
  };

  return Object.freeze({
    toast: (request: ExtensionToastRequest): ExtensionNotificationHandle => {
      beginEntry();
      const posted = center.postToast({
        message: request.message,
        ...(request.tone === undefined ? {} : { tone: request.tone }),
        ...(request.durationMs === undefined
          ? {}
          : { durationMs: request.durationMs }),
        ownerId,
      });
      return Object.freeze({ id: posted.id, dispose: () => posted.dispose() });
    },
    task: (request: ExtensionTaskRequest): ExtensionTaskHandle => {
      beginEntry();
      if (
        request.onCancel !== undefined &&
        typeof request.onCancel !== "function"
      ) {
        throw new TypeError("Task onCancel must be a function.");
      }
      const started = center.startTask({
        title: request.title,
        ...(request.message === undefined ? {} : { message: request.message }),
        ...(request.progress === undefined ? {} : { progress: request.progress }),
        ...(request.tone === undefined ? {} : { tone: request.tone }),
        ...(request.onCancel === undefined
          ? {}
          : {
              // A cancel handler is extension code on a host click path: a
              // throw there must reach the extension's diagnostics, not the
              // user's button.
              onCancel: () => {
                try {
                  request.onCancel?.();
                } catch (error) {
                  scope.report("error", "Task cancel handler failed.", error);
                }
              },
            }),
        ownerId,
      });
      return Object.freeze({
        id: started.id,
        update: (update: ExtensionTaskUpdate) => started.update(update),
        settle: (result?: ExtensionTaskSettleRequest) => started.settle(result),
        dispose: () => started.dispose(),
      });
    },
  });
}
