import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ExtensionApiScope,
  ExtensionInterpolationEditorProps,
  ExtensionResource,
  ExtensionScalarSourceEditorProps,
  ExtensionSpatialPathEditorProps,
  ExtensionSpatialPathParameter,
} from "../../../extensions/types";
import { playbackClock } from "../../../../core/playback/PlaybackClock";
import { createExtensionAnimationApi } from "../../animation/ExtensionAnimationRegistry";
import type { ScalarParameter } from "../../types";
import { ExtensionScalarEditor } from "../ExtensionScalarEditor";
import { ExtensionSpatialPathDetailView } from "../ExtensionSpatialPathDetailView";

const owned: ExtensionResource[] = [];

function api(extensionId: string) {
  const scope: ExtensionApiScope = {
    extension: { id: extensionId, version: "1.0.0" },
    signal: new AbortController().signal,
    own: (resource) => {
      owned.push(resource);
      return resource;
    },
    report: () => undefined,
  };
  return createExtensionAnimationApi(scope);
}

afterEach(async () => {
  while (owned.length > 0) {
    const resource = owned.pop();
    if (typeof resource === "function") await resource();
    else await resource?.dispose();
  }
  playbackClock.setTime(0);
});

const scalarSource = (extensionId: string, data: number) => ({
  extensionId,
  typeId: "offset",
  schemaVersion: 1,
  data,
});

function registerScalarSource(
  extensionId: string,
  editor?: (props: ExtensionScalarSourceEditorProps) => unknown,
) {
  api(extensionId).scalarSources.register({
    id: "offset",
    apiVersion: 1,
    label: "Offset",
    schemaVersion: 1,
    defaultData: 0,
    validate: () => undefined,
    compile: (data) => ({
      sample: (time) => time + (data as number),
      dispose: () => undefined,
    }),
    editor,
  });
}

function registerInterpolation(
  extensionId: string,
  editor?: (props: ExtensionInterpolationEditorProps) => unknown,
) {
  api(extensionId).interpolations.register({
    id: "curve",
    apiVersion: 1,
    label: "Curve",
    schemaVersion: 1,
    defaultData: null,
    validate: () => undefined,
    compile: ({ keyframes, segmentIndex }) => ({
      sample: () => keyframes[segmentIndex].value,
      dispose: () => undefined,
    }),
    editor,
  });
}

function editorProps(value: ScalarParameter, onChange = vi.fn()) {
  return {
    value,
    onChange,
    minTime: 0,
    duration: 100,
    minValue: -10,
    maxValue: 10,
    width: 200,
    height: 100,
  };
}

describe("ExtensionScalarEditor", () => {
  it("warns when a scalar source is missing or has no editor", () => {
    registerScalarSource("test.no-editor");
    const { rerender } = render(
      <ExtensionScalarEditor
        {...editorProps({
          type: "extension-scalar",
          source: scalarSource("test.unregistered", 0),
        })}
      />,
    );
    expect(
      screen.getByText("This scalar source is missing or does not provide an editor."),
    ).toBeInTheDocument();

    rerender(
      <ExtensionScalarEditor
        {...editorProps({
          type: "extension-scalar",
          source: scalarSource("test.no-editor", 0),
        })}
      />,
    );
    expect(
      screen.getByText("This scalar source is missing or does not provide an editor."),
    ).toBeInTheDocument();
  });

  it("mounts a scalar source editor with its domain and a live sampler", () => {
    const seen: ExtensionScalarSourceEditorProps[] = [];
    registerScalarSource("test.scalar-editor", (props) => {
      seen.push(props);
      return (
        <button type="button" onClick={() => props.onChange(props.value)}>
          sample {props.sample(5)}
        </button>
      );
    });
    const onChange = vi.fn();
    const value: ScalarParameter = {
      type: "extension-scalar",
      source: scalarSource("test.scalar-editor", 3),
    };
    render(<ExtensionScalarEditor {...editorProps(value, onChange)} />);

    fireEvent.click(screen.getByRole("button", { name: "sample 8" }));
    expect(onChange).toHaveBeenCalledWith(value);
    expect(seen[0].domain).toEqual({
      minTime: 0,
      duration: 100,
      minValue: -10,
      maxValue: 10,
      softMinValue: undefined,
      softMaxValue: undefined,
    });
  });

  it("mounts the first segment's interpolation editor", () => {
    const seen: ExtensionInterpolationEditorProps[] = [];
    registerInterpolation("test.curve-editor", (props) => {
      seen.push(props);
      return <span>segment {props.segmentIndex}</span>;
    });
    registerInterpolation("test.curve-plain");
    const plain = {
      extensionId: "test.curve-plain",
      typeId: "curve",
      schemaVersion: 1,
      data: null,
    };
    const edited = { ...plain, extensionId: "test.curve-editor" };
    render(
      <ExtensionScalarEditor
        {...editorProps({
          type: "extension-keyframed-scalar",
          keyframes: [
            { time: 0, value: 1, outgoing: plain },
            { time: 50, value: 2, outgoing: edited },
            { time: 100, value: 3 },
          ],
        })}
      />,
    );
    expect(screen.getByText("segment 1")).toBeInTheDocument();
    expect(seen[0].sample(60)).toBe(2);
  });

  it("falls back to the host spline graph when no segment has an editor", () => {
    registerInterpolation("test.curve-fallback");
    const outgoing = {
      extensionId: "test.curve-fallback",
      typeId: "curve",
      schemaVersion: 1,
      data: null,
    };
    const { container } = render(
      <ExtensionScalarEditor
        {...editorProps({
          type: "extension-keyframed-scalar",
          keyframes: [
            { time: 0, value: 1, outgoing },
            { time: 100, value: 3 },
          ],
        })}
      />,
    );
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("renders nothing for host-owned scalars", () => {
    const { container } = render(<ExtensionScalarEditor {...editorProps(4)} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("ExtensionSpatialPathDetailView", () => {
  function path(extensionId: string): ExtensionSpatialPathParameter {
    return {
      type: "extension-path2d",
      geometry: {
        extensionId,
        typeId: "line",
        schemaVersion: 1,
        data: 1,
      },
      timing: 0,
    };
  }

  function registerPath(
    extensionId: string,
    editor?: (props: ExtensionSpatialPathEditorProps) => unknown,
  ) {
    api(extensionId).spatialPaths.register({
      id: "line",
      apiVersion: 1,
      label: "Line",
      schemaVersion: 1,
      defaultData: 1,
      validate: () => undefined,
      compile: () => ({
        pointAt: (progress) => ({ x: progress, y: 0 }),
        dispose: () => undefined,
      }),
      editor,
    });
  }

  it("mounts the provider editor with the playhead and wires navigation", () => {
    registerPath("test.path-editor", (props) => (
      <span>
        at {props.currentTime} of {props.domain.duration}
      </span>
    ));
    const onBack = vi.fn();
    const onRemove = vi.fn();
    playbackClock.setTime(40);
    render(
      <ExtensionSpatialPathDetailView
        path={path("test.path-editor")}
        duration={200}
        onChange={vi.fn()}
        onBack={onBack}
        onRemove={onRemove}
      />,
    );
    expect(screen.getByText("at 40 of 200")).toBeInTheDocument();

    act(() => playbackClock.setTime(80));
    expect(screen.getByText("at 80 of 200")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back To Transform" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Path" }));
    expect(onBack).toHaveBeenCalled();
    expect(onRemove).toHaveBeenCalled();
  });

  it("warns when the provider has no editor", () => {
    registerPath("test.path-plain");
    render(
      <ExtensionSpatialPathDetailView
        path={path("test.path-plain")}
        duration={200}
        onChange={vi.fn()}
        onBack={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(
      screen.getByText(
        "This spatial-path provider is missing or does not provide an editor.",
      ),
    ).toBeInTheDocument();
  });
});
