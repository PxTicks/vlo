export type ProjectClosingHook = () => void | Promise<void>;

const projectClosingHooks = new Set<ProjectClosingHook>();

export function registerProjectClosingHook(hook: ProjectClosingHook): () => void {
  projectClosingHooks.add(hook);
  return () => projectClosingHooks.delete(hook);
}

export async function runProjectClosingHooks(): Promise<void> {
  const results = await Promise.allSettled(
    [...projectClosingHooks].map((hook) => hook()),
  );
  for (const result of results) {
    if (result.status === "rejected") {
      console.warn("Project background cleanup failed", result.reason);
    }
  }
}
