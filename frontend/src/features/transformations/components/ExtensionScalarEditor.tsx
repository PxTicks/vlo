import { Component, type ErrorInfo, type ReactNode } from "react";
import { Alert } from "@mui/material";
import type {
  ExtensionInterpolationEditorProps,
  ExtensionScalarSourceEditorProps,
} from "../../extensions/types";
import {
  extensionInterpolationRegistry,
  extensionScalarSourceRegistry,
} from "../animation";
import type { ScalarParameter } from "../types";
import {
  isExtensionKeyframedScalarParameter,
  isExtensionScalarSourceParameter,
} from "../types";
import { resolveScalar } from "../utils/resolveScalar";
import type { GraphTimeAxis } from "../utils/clipTimeDomains";
import { SplineGraph } from "./SplineEditor";

interface ExtensionScalarEditorBoundaryProps {
  readonly contributionId: string;
  readonly report: (
    level: "error",
    message: string,
    detail?: unknown,
  ) => void;
  readonly children: ReactNode;
}

interface ExtensionScalarEditorBoundaryState {
  readonly failed: boolean;
}

class ExtensionScalarEditorBoundary extends Component<
  ExtensionScalarEditorBoundaryProps,
  ExtensionScalarEditorBoundaryState
> {
  state: ExtensionScalarEditorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ExtensionScalarEditorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.report(
      "error",
      `Extension animation editor '${this.props.contributionId}' failed to render.`,
      { error, componentStack: info.componentStack },
    );
  }

  render(): ReactNode {
    return this.state.failed ? (
      <Alert severity="error">The extension animation editor failed.</Alert>
    ) : (
      this.props.children
    );
  }
}

export interface ExtensionScalarEditorProps {
  readonly value: ScalarParameter;
  readonly onChange: (value: ScalarParameter) => void;
  readonly minTime: number;
  readonly duration: number;
  readonly minValue?: number;
  readonly maxValue?: number;
  readonly softMinValue?: number;
  readonly softMaxValue?: number;
  readonly width: number;
  readonly height: number;
  readonly timeAxis?: GraphTimeAxis;
}

export function ExtensionScalarEditor({
  value,
  onChange,
  minTime,
  duration,
  minValue,
  maxValue,
  softMinValue,
  softMaxValue,
  width,
  height,
  timeAxis,
}: ExtensionScalarEditorProps) {
  const domain = {
    minTime,
    duration,
    minValue,
    maxValue,
    softMinValue,
    softMaxValue,
  };

  if (isExtensionScalarSourceParameter(value)) {
    const contribution = extensionScalarSourceRegistry.get(value.source);
    const Editor = contribution?.definition.editor as
      | ((props: ExtensionScalarSourceEditorProps) => ReactNode)
      | undefined;
    if (!contribution || !Editor) {
      return (
        <Alert severity="warning">
          This scalar source is missing or does not provide an editor.
        </Alert>
      );
    }
    return (
      <ExtensionScalarEditorBoundary
        contributionId={contribution.id}
        report={contribution.definition.report}
      >
        <Editor
          value={value}
          domain={domain}
          sample={(time) => resolveScalar(value, time)}
          onChange={onChange}
        />
      </ExtensionScalarEditorBoundary>
    );
  }

  if (isExtensionKeyframedScalarParameter(value)) {
    const segmentIndex = value.keyframes.findIndex(
      (keyframe) =>
        keyframe.outgoing !== undefined &&
        extensionInterpolationRegistry.get(keyframe.outgoing)?.definition.editor !==
          undefined,
    );
    const payload = value.keyframes[segmentIndex]?.outgoing;
    const contribution = payload
      ? extensionInterpolationRegistry.get(payload)
      : undefined;
    const Editor = contribution?.definition.editor as
      | ((props: ExtensionInterpolationEditorProps) => ReactNode)
      | undefined;
    if (!contribution || !Editor || segmentIndex < 0) {
      const fallbackOutgoing = value.keyframes.find(
        (keyframe) => keyframe.outgoing,
      )?.outgoing;
      return (
        <SplineGraph
          value={{
            type: "spline",
            points: value.keyframes.map(({ time, value: pointValue }) => ({
              time,
              value: pointValue,
            })),
          }}
          onChange={(nextValue) =>
            onChange({
              type: "extension-keyframed-scalar",
              keyframes: nextValue.points.map((point, index) => ({
                ...point,
                outgoing:
                  index < nextValue.points.length - 1
                    ? (value.keyframes[index]?.outgoing ?? fallbackOutgoing)
                    : undefined,
              })),
            })
          }
          width={width}
          height={height}
          minTime={minTime}
          duration={duration}
          timeAxis={timeAxis}
          minY={minValue}
          maxY={maxValue}
          softMin={softMinValue}
          softMax={softMaxValue}
        />
      );
    }
    return (
      <ExtensionScalarEditorBoundary
        contributionId={contribution.id}
        report={contribution.definition.report}
      >
        <Editor
          value={value}
          segmentIndex={segmentIndex}
          domain={domain}
          sample={(time) => resolveScalar(value, time)}
          onChange={onChange}
        />
      </ExtensionScalarEditorBoundary>
    );
  }

  return null;
}
