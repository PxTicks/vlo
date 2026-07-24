import { useCallback, useEffect, useMemo, useState } from "react";
import {
  resolveMenuTreeLayout,
  type MenuTreeDefinition,
  type MenuTreeLayout,
} from "./menuTree";
import {
  loadMenuTreeCustomization,
  resetMenuTreeLayout,
  saveMenuTreeLayout,
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
  const leafKey = availableLeafIds.join("\u0000");
  const defaultLayout = useMemo(
    () => resolveMenuTreeLayout(definition, null, availableLeafIds),
    [definition, leafKey],
  );
  const [layout, setLayout] = useState(defaultLayout);
  const [revision, setRevision] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const abortController = new AbortController();
    void loadMenuTreeCustomization(
      definition,
      availableLeafIds,
      abortController.signal,
    )
      .then((snapshot) => {
        setLayout(snapshot.layout);
        setRevision(snapshot.revision);
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
  }, [definition, leafKey, defaultLayout]);

  const save = useCallback(
    async (nextLayout: MenuTreeLayout): Promise<boolean> => {
      setIsSaving(true);
      setError(null);
      try {
        const snapshot = await saveMenuTreeLayout(
          definition,
          availableLeafIds,
          nextLayout,
          revision,
        );
        setLayout(snapshot.layout);
        setRevision(snapshot.revision);
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
    [availableLeafIds, definition, revision],
  );

  const reset = useCallback(async (): Promise<boolean> => {
    setIsSaving(true);
    setError(null);
    try {
      const snapshot = await resetMenuTreeLayout(
        definition,
        availableLeafIds,
      );
      setLayout(snapshot.layout);
      setRevision(snapshot.revision);
      return true;
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Failed to reset menu",
      );
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [availableLeafIds, definition]);

  return {
    layout,
    isLoading,
    isSaving,
    error,
    revision,
    save,
    reset,
    clearError: () => setError(null),
  };
}
