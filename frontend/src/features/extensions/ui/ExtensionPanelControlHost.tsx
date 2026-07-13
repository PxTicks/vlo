import { useCallback, useMemo } from "react";
import type { ComponentType } from "react";
import { jsonValueSchema } from "../persistence/extensionPayload";
import { ExtensionTrustedReactMount } from "./ExtensionTrustedReactMount";
import type {
  ExtensionApiScope,
  ExtensionPanelControlProps,
  JsonValue,
} from "../types";

const SURFACE = "Panel control";

export interface ExtensionPanelControlMountProps {
  readonly contributionId: string;
  readonly component: (props: ExtensionPanelControlProps) => unknown;
  readonly report: ExtensionApiScope["report"];
  readonly config: Readonly<Record<string, JsonValue>>;
  /** Parameters this control may commit. Undefined means "no commits allowed". */
  readonly allowedParameterNames: readonly string[] | undefined;
  readonly values: Readonly<Record<string, unknown>>;
  readonly transformId?: string;
  readonly disabled: boolean;
  readonly sourceTimeRange?: {
    readonly minTime: number;
    readonly duration: number;
  };
  readonly onCommitMany: (values: Readonly<Record<string, unknown>>) => void;
}

/** Values crossing to an extension are cloned; host state stays unreachable. */
function detachValues(
  values: Readonly<Record<string, unknown>>,
): Readonly<Record<string, JsonValue>> {
  const detached: Record<string, JsonValue> = {};
  for (const [name, value] of Object.entries(values)) {
    const parsed = jsonValueSchema.safeParse(value);
    // Host-only values (functions, non-finite numbers) are simply not visible to
    // extensions rather than failing the whole render.
    if (parsed.success) detached[name] = structuredClone(parsed.data) as JsonValue;
  }
  return Object.freeze(detached);
}

/**
 * The host side of the panel-control boundary.
 *
 * Commits go through the panel's own `onCommitMany`, so live preview, undo,
 * history, and keyframes behave exactly as they do for built-in controls. The
 * trusted mount catches render failures; failures thrown inside an extension's
 * own event handlers are not catchable by a React boundary, so commit
 * validation reports rather than throws.
 */
export function ExtensionPanelControlMount({
  contributionId,
  component,
  report,
  config,
  allowedParameterNames,
  values,
  transformId,
  disabled,
  sourceTimeRange,
  onCommitMany,
}: ExtensionPanelControlMountProps) {
  const detachedValues = useMemo(() => detachValues(values), [values]);

  const commitParameters = useCallback(
    (next: Readonly<Record<string, JsonValue>>) => {
      if (disabled) return;
      if (typeof next !== "object" || next === null || Array.isArray(next)) {
        report(
          "error",
          `Panel control '${contributionId}' committed a non-object value.`,
        );
        return;
      }
      const allowed = new Set(allowedParameterNames ?? []);
      const committed: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(next)) {
        if (!allowed.has(name)) {
          report(
            "error",
            `Panel control '${contributionId}' may not commit parameter '${name}'.`,
          );
          return;
        }
        const parsed = jsonValueSchema.safeParse(value);
        if (!parsed.success) {
          report(
            "error",
            `Panel control '${contributionId}' committed a non-JSON value for '${name}'.`,
          );
          return;
        }
        committed[name] = structuredClone(parsed.data);
      }
      if (Object.keys(committed).length === 0) return;
      onCommitMany(committed);
    },
    [
      allowedParameterNames,
      contributionId,
      disabled,
      onCommitMany,
      report,
    ],
  );

  const componentProps = useMemo<ExtensionPanelControlProps>(
    () =>
      Object.freeze({
        values: detachedValues,
        transformId,
        disabled,
        sourceTimeRange,
        config,
        commitParameter: (name: string, value: JsonValue) =>
          commitParameters({ [name]: value }),
        commitParameters,
      }),
    [
      commitParameters,
      config,
      detachedValues,
      disabled,
      sourceTimeRange,
      transformId,
    ],
  );

  return (
    <ExtensionTrustedReactMount
      contributionId={contributionId}
      surface={SURFACE}
      report={report}
      component={component as ComponentType<ExtensionPanelControlProps>}
      componentProps={componentProps}
    />
  );
}
