import type {
  ExtensionTrustedAudioEffectTransformationDefinition,
  JsonValue,
} from "../../extensions/types";
import type { ClipTransform } from "../../../types/TimelineTypes";
import {
  isExtensionKeyframedScalarParameter,
  isExtensionScalarSourceParameter,
  isSplineParameter,
  type ScalarParameter,
} from "../types";
import { resolveScalar } from "../utils/resolveScalar";
import type {
  TransformationAudioEffectInstance,
  TransformationAudioEffectRuntime,
  TransformationAudioEffectWindow,
} from "../catalogue/types";

type ReportFailureOnce = (
  key: string,
  level: "error" | "warning",
  message: string,
  detail?: unknown,
) => void;

function isAudioNodeForContext(
  value: unknown,
  context: BaseAudioContext,
): value is AudioNode {
  return (
    typeof value === "object" &&
    value !== null &&
    "context" in value &&
    value.context === context &&
    "connect" in value &&
    typeof value.connect === "function" &&
    "disconnect" in value &&
    typeof value.disconnect === "function"
  );
}

function resolveParameter(
  parameters: Readonly<Record<string, unknown>>,
  name: string,
  presentationTimeTicks: number,
  window: TransformationAudioEffectWindow,
): JsonValue | undefined {
  const value = parameters[name];
  if (
    typeof value === "number" ||
    isSplineParameter(value) ||
    isExtensionScalarSourceParameter(value) ||
    isExtensionKeyframedScalarParameter(value)
  ) {
    return resolveScalar(
      value as ScalarParameter,
      window.sourceTimeTicksAt(presentationTimeTicks),
      typeof value === "number" ? value : 0,
    );
  }
  return value === undefined
    ? undefined
    : (structuredClone(value) as JsonValue);
}

export function createTrustedExtensionAudioEffectRuntime(
  contributionId: string,
  definition: ExtensionTrustedAudioEffectTransformationDefinition,
  reportFailureOnce: ReportFailureOnce,
): TransformationAudioEffectRuntime {
  const instances = new Set<TransformationAudioEffectInstance>();
  let disposed = false;

  const runtime: TransformationAudioEffectRuntime = {
    maxTailSeconds: definition.maxTailSeconds ?? 0,
    create: (context, transformId) => {
      if (disposed) return null;
      let extensionInstance;
      try {
        extensionInstance = definition.createEffect(context);
      } catch (error) {
        reportFailureOnce(
          `audio-create:${transformId}`,
          "error",
          `Audio effect '${contributionId}' failed to create.`,
          error,
        );
        return null;
      }
      if (
        !extensionInstance ||
        !isAudioNodeForContext(extensionInstance.inputNode, context) ||
        !isAudioNodeForContext(extensionInstance.outputNode, context) ||
        typeof extensionInstance.apply !== "function"
      ) {
        reportFailureOnce(
          `audio-shape:${transformId}`,
          "error",
          `Audio effect '${contributionId}' returned invalid or foreign-context nodes.`,
        );
        return null;
      }

      let instanceDisposed = false;
      const instance: TransformationAudioEffectInstance = {
        inputNode: extensionInstance.inputNode,
        outputNode: extensionInstance.outputNode,
        schedule: (window, transform: ClipTransform) => {
          if (instanceDisposed) return;
          try {
            const parameters = Object.freeze(
              structuredClone(transform.parameters),
            ) as Readonly<Record<string, unknown>>;
            extensionInstance.apply(
              parameters,
              {
                audioContext: context,
                startContextTime: window.startContextTime,
                wallDurationSeconds: window.wallDurationSeconds,
                startPresentationTimeTicks: window.startTargetTicks,
                durationTicks: window.windowTicks,
                sampleCount: window.sampleCount,
                sourceTimeTicksAt: window.sourceTimeTicksAt,
                resolveParameter: (name, presentationTimeTicks) =>
                  resolveParameter(
                    parameters,
                    name,
                    presentationTimeTicks,
                    window,
                  ),
              },
            );
          } catch (error) {
            reportFailureOnce(
              `audio-apply:${transformId}`,
              "error",
              `Audio effect '${contributionId}' failed while scheduling automation.`,
              error,
            );
          }
        },
        dispose: () => {
          if (instanceDisposed) return;
          instanceDisposed = true;
          instances.delete(instance);
          try {
            extensionInstance.destroy?.();
          } catch (error) {
            reportFailureOnce(
              `audio-destroy:${transformId}`,
              "warning",
              `Audio effect '${contributionId}' failed during cleanup.`,
              error,
            );
          }
          for (const node of [extensionInstance.inputNode, extensionInstance.outputNode]) {
            try {
              node.disconnect();
            } catch {
              // The context or the extension may already have disconnected it.
            }
          }
        },
      };
      instances.add(instance);
      return instance;
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const instance of [...instances]) instance.dispose();
    },
  };
  return runtime;
}
