import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TimelineClip } from "../../../../types/TimelineTypes";

interface WrappedBuffer {
  buffer: AudioBuffer;
  timestamp: number;
  duration: number;
}

const mocks = vi.hoisted(() => ({
  bufferBatches: [] as WrappedBuffer[][],
  iterators: [] as Array<{
    next: ReturnType<typeof vi.fn>;
    return: ReturnType<typeof vi.fn>;
  }>,
  sinkStarts: [] as number[],
}));

vi.mock("mediabunny", () => ({
  Input: vi.fn(),
  AudioBufferSink: vi.fn(function () {
    return {
      buffers(start = 0) {
        mocks.sinkStarts.push(start);
        const values = [...(mocks.bufferBatches.shift() ?? [])];
        const iterator = {
          next: vi.fn(async () =>
            values.length > 0
              ? { done: false, value: values.shift() }
              : { done: true, value: undefined },
          ),
          return: vi.fn(async () => ({ done: true, value: undefined })),
          [Symbol.asyncIterator]() {
            return this;
          },
        };
        mocks.iterators.push(iterator);
        return iterator;
      },
    };
  }),
}));

import { TrackAudioRenderer } from "../TrackAudioRenderer";

function clip(overrides: Partial<TimelineClip> = {}): TimelineClip {
  return {
    id: "clip-1",
    type: "audio",
    trackId: "track-1",
    assetId: "asset-1",
    start: 0,
    timelineDuration: 960000,
    transformedOffset: 0,
    transformations: [],
    isMuted: false,
    ...overrides,
  } as TimelineClip;
}

function wrappedBuffer(
  duration: number,
  timestamp = 0,
  channels: number[][] = [[1, 2]],
): WrappedBuffer {
  const data = channels.map((values) => new Float32Array(values));
  const sampleRate = data[0].length / duration;
  return {
    timestamp,
    duration,
    buffer: {
      duration,
      length: data[0].length,
      sampleRate,
      numberOfChannels: data.length,
      getChannelData: vi.fn((channel: number) => data[channel]),
    } as unknown as AudioBuffer,
  };
}

function createContext(currentTime = 0) {
  const sources: Array<{
    buffer: AudioBuffer | null;
    playbackRate: {
      value: number;
      setValueCurveAtTime: ReturnType<typeof vi.fn>;
    };
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    onended: (() => void) | null;
  }> = [];
  const gains: Array<{
    gain: {
      value: number;
      cancelScheduledValues: ReturnType<typeof vi.fn>;
      setValueAtTime: ReturnType<typeof vi.fn>;
      linearRampToValueAtTime: ReturnType<typeof vi.fn>;
      setValueCurveAtTime: ReturnType<typeof vi.fn>;
    };
    connect: ReturnType<typeof vi.fn>;
  }> = [];
  const mergedBuffers: Array<{
    copyToChannel: ReturnType<typeof vi.fn>;
  }> = [];

  const context = {
    currentTime,
    createBufferSource: vi.fn(() => {
      const source = {
        buffer: null,
        playbackRate: {
          value: 1,
          setValueCurveAtTime: vi.fn(),
        },
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        onended: null,
      };
      sources.push(source);
      return source;
    }),
    createGain: vi.fn(() => {
      const gain = {
        gain: {
          value: 1,
          cancelScheduledValues: vi.fn(),
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
          setValueCurveAtTime: vi.fn(),
        },
        connect: vi.fn(),
      };
      gains.push(gain);
      return gain;
    }),
    createBuffer: vi.fn(
      (numberOfChannels: number, length: number, sampleRate: number) => {
        const merged = {
          numberOfChannels,
          length,
          sampleRate,
          duration: length / sampleRate,
          copyToChannel: vi.fn(),
          getChannelData: vi.fn(() => new Float32Array(length)),
        };
        mergedBuffers.push(merged);
        return merged;
      },
    ),
  };

  return {
    context: context as unknown as BaseAudioContext,
    sources,
    gains,
    mergedBuffers,
  };
}

function inputWithTrack(track: unknown = { id: "audio-track" }) {
  return {
    getPrimaryAudioTrack: vi.fn(async () => track),
  } as never;
}

const destination = { id: "destination" } as unknown as AudioNode;
const mapping = { baseTicks: 0, baseContextTime: 0 };

describe("TrackAudioRenderer process lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.bufferBatches = [];
    mocks.iterators = [];
    mocks.sinkStarts = [];
    vi.stubGlobal("OfflineAudioContext", class OfflineAudioContextMock {});
  });

  it("initializes, rebases chunks, and cleans scheduled nodes", () => {
    const renderer = new TrackAudioRenderer("track-1");
    const { context, sources } = createContext();
    expect(renderer.trackId).toBe("track-1");
    expect(renderer.getNextScheduleTime()).toBe(0);

    renderer.prepareForChunk(2);
    expect(renderer.getNextScheduleTime()).toBe(2);
    renderer.reset(3);
    expect(renderer.getNextScheduleTime()).toBe(3.15);

    renderer.prepareForChunk(0);
    expect(sources).toHaveLength(0);
    renderer.stop();
    renderer.dispose();
    expect(context).toBeDefined();
  });

  it("advances through gaps, muted clips, and unsupported clip types", async () => {
    const renderer = new TrackAudioRenderer("track-1");
    const { context } = createContext();
    const getInput = vi.fn();

    await renderer.process(
      context,
      destination,
      [],
      getInput,
      mapping,
      { lookahead: 0.25 },
    );
    expect(renderer.getNextScheduleTime()).toBeCloseTo(0.3);
    expect(getInput).not.toHaveBeenCalled();

    renderer.prepareForChunk(0);
    await renderer.process(
      context,
      destination,
      [
        clip({ isMuted: true }),
        clip({ id: "text", type: "text" }),
      ],
      getInput,
      mapping,
      { lookahead: 0.15 },
    );
    expect(getInput).not.toHaveBeenCalled();
  });

  it("handles missing assets, inputs, tracks, and track initialization errors", async () => {
    const { context } = createContext();

    const missingAsset = new TrackAudioRenderer("track-1");
    await missingAsset.process(
      context,
      destination,
      [clip({ assetId: undefined })],
      vi.fn(),
      mapping,
      { lookahead: 0.05 },
    );

    const missingInput = new TrackAudioRenderer("track-1");
    await missingInput.process(
      context,
      destination,
      [clip()],
      vi.fn(async () => null),
      mapping,
      { lookahead: 0.05 },
    );

    const noTrack = new TrackAudioRenderer("track-1");
    const noTrackInput = inputWithTrack(null);
    await noTrack.process(
      context,
      destination,
      [clip()],
      vi.fn(async () => noTrackInput),
      mapping,
      { lookahead: 0.15 },
    );
    expect(
      (noTrackInput as unknown as {
        getPrimaryAudioTrack: ReturnType<typeof vi.fn>;
      }).getPrimaryAudioTrack,
    ).toHaveBeenCalledOnce();

    const failing = new TrackAudioRenderer("track-1");
    const errorInput = {
      getPrimaryAudioTrack: vi.fn(async () => {
        throw new Error("decode failed");
      }),
    } as never;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await failing.process(
      context,
      destination,
      [clip()],
      vi.fn(async () => errorInput),
      mapping,
      { lookahead: 0.15 },
    );
    expect(warnSpy).toHaveBeenCalledWith(
      "Audio Init Failed",
      expect.any(Error),
    );
  });

  it("schedules a constant-gain buffer with de-click ramps", async () => {
    mocks.bufferBatches = [[wrappedBuffer(0.2)], []];
    const renderer = new TrackAudioRenderer("track-1");
    const { context, sources, gains } = createContext();

    await renderer.process(
      context,
      destination,
      [clip()],
      vi.fn(async () => inputWithTrack()),
      mapping,
      { lookahead: 0.05, forceFlush: true },
    );

    expect(sources).toHaveLength(1);
    expect(sources[0].start).toHaveBeenCalledWith(0);
    expect(sources[0].playbackRate.setValueCurveAtTime).toHaveBeenCalledWith(
      expect.any(Float32Array),
      0,
      expect.closeTo(0.2),
    );
    expect(gains[0].gain.cancelScheduledValues).toHaveBeenCalledWith(0);
    expect(gains[0].gain.linearRampToValueAtTime).toHaveBeenCalledTimes(2);
    expect(renderer.getNextScheduleTime()).toBeCloseTo(0.2);

    sources[0].onended?.();
    renderer.stop();
    expect(sources[0].stop).not.toHaveBeenCalled();
  });

  it("merges staged buffers before scheduling", async () => {
    mocks.bufferBatches = [
      [wrappedBuffer(1.1, 1), wrappedBuffer(1.1, 2.1)],
      [],
    ];
    const renderer = new TrackAudioRenderer("track-1");
    renderer.prepareForChunk(1);
    const { context, mergedBuffers, sources } = createContext(0);

    await renderer.process(
      context,
      destination,
      [clip()],
      vi.fn(async () => inputWithTrack()),
      mapping,
      { lookahead: 2.5, forceFlush: true },
    );

    expect(mergedBuffers).toHaveLength(1);
    expect(mergedBuffers[0].copyToChannel).toHaveBeenCalledTimes(2);
    expect(sources[0].buffer).toBe(mergedBuffers[0]);
  });

  it("applies keyframed gain curves and falls back when automation rejects", async () => {
    mocks.bufferBatches = [[wrappedBuffer(0.2)], []];
    const renderer = new TrackAudioRenderer("track-1");
    const { context, sources, gains } = createContext();
    const originalCreateSource = (
      context as unknown as {
        createBufferSource: ReturnType<typeof vi.fn>;
      }
    ).createBufferSource;
    originalCreateSource.mockImplementationOnce(() => {
      const source = {
        buffer: null,
        playbackRate: {
          value: 1,
          setValueCurveAtTime: vi.fn(() => {
            throw new Error("unsupported");
          }),
        },
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        onended: null,
      };
      sources.push(source);
      return source;
    });
    const originalCreateGain = (
      context as unknown as { createGain: ReturnType<typeof vi.fn> }
    ).createGain;
    originalCreateGain.mockImplementationOnce(() => {
      const gain = {
        gain: {
          value: 1,
          cancelScheduledValues: vi.fn(),
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
          setValueCurveAtTime: vi.fn(() => {
            throw new Error("unsupported");
          }),
        },
        connect: vi.fn(),
      };
      gains.push(gain);
      return gain;
    });

    await renderer.process(
      context,
      destination,
      [
        clip({
          transformations: [
            {
              id: "volume",
              type: "volume",
              isEnabled: true,
              parameters: {
                gain: {
                  type: "spline",
                  points: [
                    { time: 0, value: 0.2 },
                    { time: 96000, value: 0.8 },
                  ],
                },
              },
            },
          ],
        }),
      ],
      vi.fn(async () => inputWithTrack()),
      mapping,
      { lookahead: 0.05, forceFlush: true },
    );

    expect(sources[0].playbackRate.value).toBeGreaterThan(0);
    expect(gains[0].gain.setValueCurveAtTime).toHaveBeenCalled();
    expect(gains[0].gain.value).toBe(0);
  });

  it("late-schedules remaining audio with a playback-rate-adjusted offset", async () => {
    mocks.bufferBatches = [[wrappedBuffer(0.5)], []];
    const renderer = new TrackAudioRenderer("track-1");
    const { context, sources } = createContext(0.1);

    await renderer.process(
      context,
      destination,
      [clip()],
      vi.fn(async () => inputWithTrack()),
      mapping,
      { lookahead: 0.01, forceFlush: true },
    );

    expect(sources[0].start).toHaveBeenCalledWith(
      0.1,
      expect.closeTo(0.1),
    );
  });

  it("restarts the iterator after a seek and closes iterators on disposal", async () => {
    mocks.bufferBatches = [
      [wrappedBuffer(0.05, 0)],
      [wrappedBuffer(0.05, 1)],
      [],
    ];
    const renderer = new TrackAudioRenderer("track-1");
    const { context } = createContext();
    const input = inputWithTrack();

    await renderer.process(
      context,
      destination,
      [clip()],
      vi.fn(async () => input),
      mapping,
      { lookahead: 0.01 },
    );
    renderer.prepareForChunk(1);
    await renderer.process(
      context,
      destination,
      [clip()],
      vi.fn(async () => input),
      mapping,
      { lookahead: 1.01 },
    );

    expect(mocks.sinkStarts.length).toBeGreaterThanOrEqual(2);
    expect(mocks.iterators[0].return).toHaveBeenCalled();
    renderer.dispose();
  });

  it("uses adjustment lookup timing and the live clip data", async () => {
    mocks.bufferBatches = [[wrappedBuffer(0.2)], []];
    const liveClip = clip({
      transformations: [
        {
          id: "volume",
          type: "volume",
          isEnabled: true,
          parameters: { gain: 0.4 },
        },
      ],
    });
    const lookup = {
      findActiveClipAt: vi.fn(() => ({
        clipId: liveClip.id,
        effectiveTick: 48000,
      })),
      resolveEffectiveTrackTickWithinClip: vi.fn(
        (_clip: TimelineClip, tick: number) => tick,
      ),
    };
    const renderer = new TrackAudioRenderer("track-1", {
      getPresentationLookup: () => lookup,
    } as never);
    const { context, gains } = createContext();

    await renderer.process(
      context,
      destination,
      [liveClip],
      vi.fn(async () => inputWithTrack()),
      mapping,
      { lookahead: 0.05, forceFlush: true },
    );

    expect(lookup.findActiveClipAt).toHaveBeenCalled();
    expect(lookup.resolveEffectiveTrackTickWithinClip).toHaveBeenCalled();
    expect(gains[0].gain.linearRampToValueAtTime).toHaveBeenCalledWith(
      0.4,
      expect.any(Number),
    );
  });
});
