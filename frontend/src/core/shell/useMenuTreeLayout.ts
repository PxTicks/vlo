import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createMenuTreeCustomization,
  resolveMenuTreeLayout,
  type MenuTreeCustomization,
  type MenuTreeDefinition,
  type MenuTreeLayout,
} from "./menuTree";
import {
  fetchMenuTreeCustomization,
  resetMenuTreeCustomization,
  saveMenuTreeCustomization,
} from "./menuTreePersistence";

export interface MenuTreeLayoutController {
  readonly layout: MenuTreeLayout;
  readonly isLoading: boolean;
  readonly isSaving: boolean;
  readonly error: string | null;
  readonly revision: number;
  readonly save: (layout: MenuTreeLayout) => Promise<boolean>;
  readonly reset: () => Promise<boolean>;
  readonly clearError: () => void;
}

export function useMenuTreeLayout(
  definition: MenuTreeDefinition,
  availableLeafIds: readonly string[],
): MenuTreeLayoutController {
  const [revision, setRevision] = useState(0);
  const [customization, setCustomization] =
    useState<MenuTreeCustomization | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const layout = useMemo(
    () => resolveMenuTreeLayout(definition, customization, availableLeafIds),
    [availableLeafIds, customization, definition],
  );

  useEffect(() => {
    const abortController = new AbortController();
    void fetchMenuTreeCustomization(definition.id, abortController.signal)
      .then((snapshot) => {
        setRevision(snapshot.revision);
        setCustomization(snapshot.customization);
      })
      .catch((reason: unknown) => {
        if (abortController.signal.aborted) return;
        setError(
          reason instanceof Error
            ? reason.message
            : "Failed to load menu customizations",
        );
      })
      .finally(() => {
        if (!abortController.signal.aborted) setIsLoading(false);
      });
    return () => abortController.abort();
  }, [definition]);

  const save = useCallback(
    async (nextLayout: MenuTreeLayout): Promise<boolean> => {
      setIsSaving(true);
      setError(null);
      try {
        const nextCustomization = createMenuTreeCustomization(
          definition,
          nextLayout,
          customization,
        );
        const snapshot = await saveMenuTreeCustomization(
          definition.id,
          nextCustomization,
          revision,
        );
        setRevision(snapshot.revision);
        setCustomization(snapshot.customization);
        return true;
      } catch (reason) {
        setError(
          reason instanceof Error ? reason.message : "Failed to save menu",
        );
        return false;
      } finally {
        setIsSaving(false);
      }
    },
    [customization, definition, revision],
  );

  const reset = useCallback(async (): Promise<boolean> => {
    setIsSaving(true);
    setError(null);
    try {
      const snapshot = await resetMenuTreeCustomization(definition.id);
      setRevision(snapshot.revision);
      setCustomization(snapshot.customization);
      return true;
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Failed to reset menu",
      );
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [definition.id]);

  const clearError = useCallback(() => setError(null), []);

  return {
    layout,
    isLoading,
    isSaving,
    error,
    revision,
    save,
    reset,
    clearError,
  };
}
