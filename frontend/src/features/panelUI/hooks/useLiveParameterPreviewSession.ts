import { useCallback, useEffect, useRef } from "react";
import { livePreviewParamStore } from "../../../core/liveParams/livePreviewParamStore";

export type LiveParameterChanges = Readonly<Record<string, unknown>>;

interface LiveParameterPreviewSessionOptions {
  transformId?: string;
  onCommitMany(changes: LiveParameterChanges): void;
}

export interface LiveParameterPreviewSession {
  /** Start a distinct pointer/gesture transaction. */
  begin(): void;
  /** Merge model-space values into the pending snapshot and renderer overrides. */
  preview(changes: LiveParameterChanges): void;
  /** Persist the exact pending snapshot, optionally including final values. */
  commit(finalChanges?: LiveParameterChanges): void;
  /** Drop pending values and renderer overrides without persistence. */
  cancel(): void;
}

export function useLiveParameterPreviewSession({
  transformId,
  onCommitMany,
}: LiveParameterPreviewSessionOptions): LiveParameterPreviewSession {
  const onCommitManyRef = useRef(onCommitMany);
  const pendingRef = useRef<Record<string, unknown> | null>(null);
  const previewedNamesRef = useRef(new Set<string>());

  useEffect(() => {
    onCommitManyRef.current = onCommitMany;
  }, [onCommitMany]);

  const clearOverrides = useCallback(() => {
    const names = [...previewedNamesRef.current];
    previewedNamesRef.current.clear();
    if (!transformId || names.length === 0) return;
    livePreviewParamStore.clearMany(
      names.map((paramName) => ({ transformId, paramName })),
    );
  }, [transformId]);

  const cancel = useCallback(() => {
    pendingRef.current = null;
    clearOverrides();
  }, [clearOverrides]);

  useEffect(() => cancel, [cancel]);

  const begin = useCallback(() => {
    cancel();
    pendingRef.current = {};
  }, [cancel]);

  const preview = useCallback(
    (changes: LiveParameterChanges) => {
      pendingRef.current = { ...pendingRef.current, ...changes };
      Object.keys(changes).forEach((name) => previewedNamesRef.current.add(name));
      if (!transformId) return;
      livePreviewParamStore.setMany(
        Object.entries(changes).map(([paramName, value]) => ({
          transformId,
          paramName,
          value,
        })),
      );
    },
    [transformId],
  );

  const commit = useCallback(
    (finalChanges: LiveParameterChanges = {}) => {
      const changes = { ...pendingRef.current, ...finalChanges };
      pendingRef.current = null;
      if (Object.keys(changes).length === 0) {
        clearOverrides();
        return;
      }
      try {
        onCommitManyRef.current(changes);
      } finally {
        clearOverrides();
      }
    },
    [clearOverrides],
  );

  return { begin, preview, commit, cancel };
}
