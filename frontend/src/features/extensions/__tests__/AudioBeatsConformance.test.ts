import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Input, InputAudioTrack, WrappedAudioBuffer } from "mediabunny";
import type {
  ExtensionApiScope,
  ExtensionResource,
  VloExtensionApi,
} from "../types";
import {
  activate,
  detectTransientSourceTicks,
  getAudioBeatStateForConformance,
  resetAudioBeatStateForConformance,
} from "../../../../../extension-fixtures/audio-beats/frontend/src/index";
import { HostCommandTable } from "../../../core/shell/commandTable";
import { HostContextKeyService } from "../../../core/shell/contextKeys";
import { HostKeybindingRegistry } from "../../../core/shell/keybindingRegistry";
import { useTimelineStore } from "../../timeline/useTimelineStore";
import { AudioAnalysisService, useAssetStore } from "../../userAssets";
import type { Asset } from "../../../types/Asset";
import type { TimelineClip, TimelineTrack } from "../../../types/TimelineTypes";
import { createExtensionAudioApi } from "../audio/createExtensionAudioApi";
import { createExtensionCommandApi } from "../commands/CommandRegistry";
import { createExtensionTimelineApi } from "../timeline/createExtensionTimelineApi";
import { extensionTransformationRegistry } from "../../transformations/extensionApi";

const TICKS_PER_SECOND = 96_000;

function createDecoder(
  values: readonly number[],
  sampleRate: number,
  firstTimestampSeconds: number,
) {
  const track = {
    sampleRate,
    numberOfChannels: 1,
    canDecode: vi.fn(async () => true),
    computeDuration: vi.fn(
      async () => firstTimestampSeconds + values.length / sampleRate,
    ),
    getFirstTimestamp: vi.fn(async () => firstTimestampSeconds),
  } as unknown as InputAudioTrack;
  const input = {
    getPrimaryAudioTrack: vi.fn(async () => track),
  } as unknown as Input;
  const wrapped: WrappedAudioBuffer = {
    timestamp: firstTimestampSeconds,
    duration: values.length / sampleRate,
    buffer: {
      sampleRate,
      numberOfChannels: 1,
      length: values.length,
      getChannelData: () => Float32Array.from(values),
    } as unknown as AudioBuffer,
  };
  const createSink = () => ({
    buffers: async function* () {
      yield wrapped;
    },
  });
  return {
    input,
    analysis: new AudioAnalysisService({
      getInput: async () => input,
      createSink,
    }),
  };
}

function createHarness(
  values: readonly number[],
  sampleRate: number,
  firstTimestampSeconds = 0,
) {
  const contextKeys = new HostContextKeyService();
  const commandTable = new HostCommandTable(contextKeys);
  const keybindings = new HostKeybindingRegistry(() => false);
  contextKeys.set("project.open", true);

  const resources: ExtensionResource[] = [];
  const scope: ExtensionApiScope = {
    extension: { id: "example.audio-beats", version: "1.0.0" },
    signal: new AbortController().signal,
    own: <TResource extends ExtensionResource>(resource: TResource) => {
      resources.push(resource);
      return resource;
    },
    report: vi.fn(),
  };
  const decoder = createDecoder(values, sampleRate, firstTimestampSeconds);
  const api = {
    audio: createExtensionAudioApi(scope, {
      analysis: decoder.analysis,
    }),
    timeline: createExtensionTimelineApi(scope),
    transformations: {
      ...extensionTransformationRegistry.bind(scope),
      presets: { register: vi.fn() },
    },
    ui: {
      commands: createExtensionCommandApi(
        scope,
        commandTable,
        keybindings,
        contextKeys,
      ),
    },
  } as unknown as VloExtensionApi;

  return {
    api,
    scope,
    resources,
    dispose: async () => {
      for (const resource of [...resources].reverse()) {
        await (typeof resource === "function" ? resource() : resource.dispose());
      }
    },
  };
}

function seedTimeline(): void {
  const track: TimelineTrack = {
    id: "track-audio",
    label: "Audio",
    type: "audio",
    isVisible: true,
    isMuted: false,
    isLocked: false,
  };
  const clip: TimelineClip = {
    id: "clip-audio",
    type: "audio",
    name: "Audio",
    assetId: "asset-audio",
    trackId: track.id,
    sourceDuration: 192_000,
    transformedDuration: 192_000,
    transformedOffset: 0,
    timelineDuration: 192_000,
    croppedSourceDuration: 192_000,
    offset: 0,
    start: 0,
    transformations: [],
  } as TimelineClip;
  const asset: Asset = {
    id: "asset-audio",
    hash: "hash-audio",
    name: "Audio",
    type: "audio",
    src: "audio.wav",
    duration: 2,
    hasAudio: true,
    createdAt: 1,
  };
  useAssetStore.setState({ assets: [asset] });
  useTimelineStore.setState({
    tracks: [track],
    clips: [clip],
    transitions: [],
    selectedClipIds: [],
    selectedTransitionId: null,
  });
}

beforeEach(() => {
  seedTimeline();
  resetAudioBeatStateForConformance();
});

afterEach(() => {
  resetAudioBeatStateForConformance();
});

describe("audio beats conformance fixture", () => {
  it("detects rising transients with a deterministic minimum gap", () => {
    expect(
      detectTransientSourceTicks(
        [Float32Array.from([0, 0.9, 1, 0, 0.85, 0, 0.95])],
        10,
        0,
        TICKS_PER_SECOND,
      ),
    ).toEqual([9_600, 38_400, 57_600]);
  });

  it("keeps source ticks zero-anchored for a negative decoder origin", async () => {
    const samples = Array.from({ length: 20 }, () => 0);
    samples[5] = 1;
    samples[15] = -1;
    const harness = createHarness(samples, 10, -1);
    const disposers: ExtensionResource[] = [];
    activate({
      extension: { id: "example.audio-beats", version: "1.0.0" },
      sdkVersion: "1.12.0",
      signal: harness.scope.signal,
      api: harness.api,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      onDispose: (resource) => disposers.push(resource),
    });

    expect(getAudioBeatStateForConformance().effectId).toBe(
      "example.audio-beats/transient-compressor",
    );
    expect(
      await harness.api.ui.commands.execute("analyse-and-split-transients"),
    ).toBe(true);

    expect(getAudioBeatStateForConformance()).toMatchObject({
      sourceTicks: [48_000],
      splitTicks: [48_000],
      transaction: { ok: true },
    });
    expect(
      useTimelineStore
        .getState()
        .clips.filter((clip) => clip.type !== "mask")
        .map((clip) => clip.start)
        .sort((left, right) => left - right),
    ).toEqual([0, 48_000]);

    for (const resource of disposers) {
      await (typeof resource === "function" ? resource() : resource.dispose());
    }
    await harness.dispose();
  });
});
