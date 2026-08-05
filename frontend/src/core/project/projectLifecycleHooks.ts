export type ProjectClosingHook = () => void | Promise<void>;

const projectClosingHooks = new Set<ProjectClosingHook>();

export function registerProjectClosingHook(hook: ProjectClosingHook): () => void {
  projectClosingHooks.add(hook);
  return () => projectClosingHooks.delete(hook);
}

export async function runProjectClosingHooks(): Promise<void> {
  // The project is going away: its save record belongs to the session that is
  // ending, not to whatever opens next (see {@link clearProjectSaveRecord}).
  clearProjectSaveRecord();
  const results = await Promise.allSettled(
    [...projectClosingHooks].map((hook) => hook()),
  );
  for (const result of results) {
    if (result.status === "rejected") {
      console.warn("Project background cleanup failed", result.reason);
    }
  }
}

/** When the project document for a given project was last written. */
export interface ProjectSaveRecord {
  readonly projectId: string;
  readonly savedAt: number;
}

let lastProjectSave: ProjectSaveRecord | null = null;
let projectSaveRevision = 0;
const projectSavedListeners = new Set<() => void>();

/**
 * A save is an edge that leaves no trace in project state — the document on
 * disk changes, the store does not — so it is recorded here as a timestamp
 * observers can read. That keeps "the project was saved" inside the same
 * snapshot-plus-revision shape every other read surface uses, instead of
 * needing an event channel of its own.
 */
export function notifyProjectSaved(projectId: string): void {
  lastProjectSave = { projectId, savedAt: Date.now() };
  notifySaveListeners();
}

function notifySaveListeners(): void {
  projectSaveRevision += 1;
  for (const listener of [...projectSavedListeners]) {
    try {
      listener();
    } catch (error) {
      console.warn("Project save listener failed", error);
    }
  }
}

/**
 * The last save of the currently open project, or null when it has not been
 * saved since it opened. Cleared by {@link runProjectClosingHooks} — the ID
 * alone cannot distinguish sessions, so reopening the same project would
 * otherwise report the previous session's save time.
 */
export function getLastProjectSave(): ProjectSaveRecord | null {
  return lastProjectSave;
}

/**
 * Drops the save record and moves the token, so a reader that cached
 * `lastSavedAt` sees the change rather than holding a stale timestamp.
 */
export function clearProjectSaveRecord(): void {
  if (lastProjectSave === null) return;
  lastProjectSave = null;
  notifySaveListeners();
}

/**
 * Counts saves rather than reporting the timestamp, so two saves in the same
 * millisecond are still two distinct change tokens.
 */
export function getProjectSaveRevision(): number {
  return projectSaveRevision;
}

export function subscribeProjectSaved(listener: () => void): () => void {
  projectSavedListeners.add(listener);
  return () => projectSavedListeners.delete(listener);
}
