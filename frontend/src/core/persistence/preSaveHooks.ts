export type PreSaveHook = () => Promise<void> | void;

const preSaveHooks = new Set<PreSaveHook>();

export function registerPreSaveHook(hook: PreSaveHook): () => void {
  preSaveHooks.add(hook);

  return () => {
    preSaveHooks.delete(hook);
  };
}

export async function runPreSaveHooks(): Promise<number> {
  const hooks = Array.from(preSaveHooks);

  for (const hook of hooks) {
    await hook();
  }

  return hooks.length;
}
