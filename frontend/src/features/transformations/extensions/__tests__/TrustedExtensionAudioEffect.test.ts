import { describe, expect, it, vi } from "vitest";
import type {
  ExtensionApiScope,
  ExtensionResource,
  ExtensionTrustedAudioEffectApplyContext,
} from "../../../extensions/types";
import type { TimelineClip } from "../../../../types/TimelineTypes";
import {
  buildAudioEffectChain,
  estimateAudioEffectTailSeconds,
  getAudioEffectTransforms,
} from "../../../renderer/services/audioEffectChain";
import { getEntryByType } from "../../catalogue/TransformationRegistry";
import { extensionTransformationRegistry } from "../ExtensionTransformationRegistry";

function createScope(report = vi.fn()): ExtensionApiScope {
  return {
    extension: { id: "example.audio-fx", version: "1.0.0" },
    signal: new AbortController().signal,
    own: <TResource extends ExtensionResource>(resource: TResource) => resource,
    report,
  };
}

function createNode(context: BaseAudioContext) {
  return {
    context,
    connect: vi.fn(),
    disconnect: vi.fn(),
  } as unknown as AudioNode;
}

function audioClip(type: string): TimelineClip {
  return {
    id: "clip-1",
    type: "audio",
    name: "Audio",
    assetId: "asset-1",
    trackId: "track-1",
    sourceDuration: 96_000,
    transformedDuration: 96_000,
    transformedOffset: 0,
    timelineDuration: 96_000,
    croppedSourceDuration: 96_000,
    offset: 0,
    start: 0,
    transformations: [
      {
        id: "effect-1",
        type,
        isEnabled: true,
        parameters: { drive: 0.75, metadata: { source: "authored" } },
      },
    ],
  } as TimelineClip;
}

describe("trusted audio effect adapter", () => {
  it("registers an audio-only transform and schedules it in preview/export chains", () => {
    const apply = vi.fn<
      (
        parameters: Readonly<Record<string, unknown>>,
        context: ExtensionTrustedAudioEffectApplyContext,
      ) => void
    >();
    const destroy = vi.fn();
    const scope = createScope();
    const registration = extensionTransformationRegistry.bind(scope).register({
      id: "drive",
      apiVersion: 1,
      kind: "trusted-audio-effect",
      label: "Drive",
      maxTailSeconds: 1.5,
      groups: [
        {
          id: "drive",
          title: "Drive",
          controls: [
            {
              type: "slider",
              name: "drive",
              label: "Drive",
              defaultValue: 0.5,
              min: 0,
              max: 1,
              step: 0.01,
            },
          ],
        },
      ],
      createEffect: (audioContext) => ({
        inputNode: createNode(audioContext),
        outputNode: createNode(audioContext),
        apply,
        destroy,
      }),
    });

    try {
      const entry = getEntryByType(registration.id);
      expect(entry).toMatchObject({
        type: registration.id,
        compatibleClips: "audio",
      });

      const clip = audioClip(registration.id);
      const transforms = getAudioEffectTransforms(clip);
      expect(transforms).toHaveLength(1);
      expect(estimateAudioEffectTailSeconds(transforms)).toBe(1.5);

      const context = {
        currentTime: 0,
        sampleRate: 48_000,
      } as BaseAudioContext;
      const chain = buildAudioEffectChain(context, transforms);
      expect(chain).not.toBeNull();
      chain?.scheduleAutomation(
        {
          startContextTime: 2,
          wallDurationSeconds: 0.5,
          startTargetTicks: 48_000,
          windowTicks: 48_000,
          sampleCount: 32,
          sourceTimeTicksAt: (tick) => tick + 100,
        },
        transforms,
      );

      expect(apply).toHaveBeenCalledTimes(1);
      const [parameters, applyContext] = apply.mock.calls[0]!;
      expect(parameters).toEqual({
        drive: 0.75,
        metadata: { source: "authored" },
      });
      expect(parameters).not.toBe(transforms[0]!.parameters);
      expect(parameters.metadata).not.toBe(
        transforms[0]!.parameters.metadata,
      );
      expect(Object.isFrozen(parameters)).toBe(true);
      expect(applyContext.resolveParameter("drive", 48_000)).toBe(0.75);
      expect(applyContext).toMatchObject({
        startContextTime: 2,
        wallDurationSeconds: 0.5,
        startPresentationTimeTicks: 48_000,
        durationTicks: 48_000,
      });

      chain?.dispose();
      expect(destroy).toHaveBeenCalledTimes(1);
    } finally {
      registration.dispose();
    }
  });

  it("isolates invalid nodes and constructor failures as diagnostics", () => {
    const report = vi.fn();
    const registration = extensionTransformationRegistry
      .bind(createScope(report))
      .register({
        id: "broken",
        apiVersion: 1,
        kind: "trusted-audio-effect",
        label: "Broken",
        groups: [
          {
            id: "main",
            title: "Main",
            controls: [
              {
                type: "slider",
                name: "amount",
                label: "Amount",
                defaultValue: 1,
                min: 0,
                max: 1,
              },
            ],
          },
        ],
        createEffect: () => {
          throw new Error("boom");
        },
      });

    try {
      const clip = audioClip(registration.id);
      clip.transformations.push({
        id: "native-pan",
        type: "pan",
        isEnabled: true,
        parameters: { pan: 0.4 },
      });
      const pan = { setValueAtTime: vi.fn() };
      const context = {
        sampleRate: 48_000,
        createStereoPanner: () => ({ ...createNode(context), pan }),
      } as unknown as BaseAudioContext;
      const transforms = getAudioEffectTransforms(clip);
      const chain = buildAudioEffectChain(context, transforms);
      expect(chain).not.toBeNull();
      chain?.scheduleAutomation(
        {
          startContextTime: 0,
          wallDurationSeconds: 1,
          startTargetTicks: 0,
          windowTicks: 96_000,
          sampleCount: 2,
          sourceTimeTicksAt: (tick) => tick,
        },
        transforms,
      );
      // A failed extension segment is bypassed without shifting the native
      // segments that follow it out of their authored transform slots.
      expect(pan.setValueAtTime).toHaveBeenCalledWith(0.4, 0);
      expect(report).toHaveBeenCalledWith(
        "error",
        expect.stringContaining("failed to create"),
        expect.any(Error),
      );
    } finally {
      registration.dispose();
    }
  });
});
