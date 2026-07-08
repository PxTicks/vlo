import { describe, expect, it, vi } from "vitest";
import type {
  ExtensionApiScope,
  ExtensionResource,
} from "../../../extensions/types";
import type {
  TimelineClip,
  Transition,
} from "../../../../types/TimelineTypes";
import {
  ExtensionTransitionRegistry,
  extensionTransitionRegistry,
} from "../ExtensionTransitionRegistry";
import { validateTransitionParameterUpdates } from "../../catalogue/TransitionRegistry";

function createScope(extensionId: string): ExtensionApiScope {
  return {
    extension: { id: extensionId, version: "1.0.0" },
    signal: new AbortController().signal,
    own: <TResource extends ExtensionResource>(resource: TResource) => resource,
    report: vi.fn(),
  };
}

function clip(id: string): TimelineClip {
  return {
    id,
    type: "video",
    name: id,
    trackId: "track-1",
    assetId: `asset-${id}`,
    start: 0,
    timelineDuration: 100,
    sourceDuration: 100,
    croppedSourceDuration: 100,
    transformedDuration: 100,
    transformedOffset: 0,
    offset: 0,
    transformations: [],
  };
}

function transition(): Transition {
  return {
    id: "transition-1",
    type: "example.transitions/wipe",
    outgoingClipId: "outgoing",
    incomingClipId: "incoming",
    schemaVersion: 1,
    parameters: { strength: 0.5 },
  };
}

describe("ExtensionTransitionRegistry", () => {
  it("registers owner-qualified transition definitions and disposes them", () => {
    const registry = new ExtensionTransitionRegistry();
    const registration = registry.bind(createScope("example.transitions")).register({
      id: "wipe",
      apiVersion: 1,
      label: "Wipe",
      glyph: "W",
      schemaVersion: 1,
      groups: [
        {
          id: "motion",
          title: "Motion",
          controls: [
            {
              type: "slider",
              name: "strength",
              label: "Strength",
              defaultValue: 0.5,
              min: 0,
              max: 1,
            },
          ],
        },
      ],
      renderFrame: ({ progress, parameters }) => ({
        outgoingTransforms: [
          {
            id: "shift",
            type: "position",
            parameters: {
              x: -100 * progress * Number(parameters.strength),
              y: 0,
            },
          },
        ],
      }),
    });

    const definition = registry.getDefinition("example.transitions/wipe");
    expect(definition).toMatchObject({
      type: "example.transitions/wipe",
      label: "Wipe",
      schemaVersion: 1,
      parameters: { strength: 0.5 },
    });

    const frame = definition?.renderFrame?.({
      transition: transition(),
      outgoingClip: clip("outgoing"),
      incomingClip: clip("incoming"),
      progress: 0.5,
      startTick: 50,
      endTick: 100,
      durationTicks: 50,
      presentationTick: 75,
      fps: 30,
      logicalDimensions: { width: 1920, height: 1080 },
    });
    expect(frame?.outgoingTransforms?.[0]).toMatchObject({
      id: "transition-1:extension:outgoing:shift",
      type: "position",
      parameters: { x: -25, y: 0 },
    });

    registration.dispose();
    expect(registry.getDefinition("example.transitions/wipe")).toBeUndefined();
  });

  it("rejects invalid defaults before registration", () => {
    const registry = new ExtensionTransitionRegistry();
    expect(() =>
      registry.bind(createScope("example.transitions")).register({
        id: "bad",
        apiVersion: 1,
        label: "Bad",
        glyph: "B",
        schemaVersion: 1,
        groups: [
          {
            id: "motion",
            title: "Motion",
            controls: [
              {
                type: "slider",
                name: "strength",
                label: "Strength",
                defaultValue: 2,
                min: 0,
                max: 1,
              },
            ],
          },
        ],
        renderFrame: () => ({}),
      }),
    ).toThrow(/invalid numeric bounds/);
  });

  it("validates extension transition parameter updates through the catalogue", () => {
    const registration = extensionTransitionRegistry
      .bind(createScope("example.validation-transitions"))
      .register({
        id: "even",
        apiVersion: 1,
        label: "Even",
        glyph: "E",
        schemaVersion: 1,
        groups: [
          {
            id: "values",
            title: "Values",
            controls: [
              {
                type: "number",
                name: "amount",
                label: "Amount",
                defaultValue: 2,
                min: 0,
                max: 10,
              },
            ],
          },
        ],
        validateParameters: (parameters) =>
          typeof parameters.amount === "number" && parameters.amount % 2 === 0,
        renderFrame: () => ({}),
      });

    try {
      const value: Transition = {
        id: "transition-even",
        type: "example.validation-transitions/even",
        outgoingClipId: "outgoing",
        incomingClipId: "incoming",
        schemaVersion: 1,
        parameters: { amount: 2 },
      };
      expect(validateTransitionParameterUpdates(value, { amount: 3 })).toBe(
        false,
      );
      expect(validateTransitionParameterUpdates(value, { amount: 4 })).toBe(
        true,
      );
    } finally {
      registration.dispose();
    }
  });
});
