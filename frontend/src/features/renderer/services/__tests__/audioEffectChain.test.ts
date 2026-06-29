import { describe, expect, it, vi } from "vitest";
import type { TimelineClip } from "../../../../types/TimelineTypes";
import type {
  AudioEffectTransform,
  ScalarParameter,
} from "../../../transformations";
import {
  buildAudioEffectChain,
  computeAudioEffectSignature,
  getAudioEffectTransforms,
  getReverbImpulseResponse,
  type AudioEffectAutomationWindow,
} from "../audioEffectChain";

function makeParam() {
  return {
    value: 0,
    setValueAtTime: vi.fn(),
    setValueCurveAtTime: vi.fn(),
  };
}

interface FakeNode {
  __type: string;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  [key: string]: unknown;
}

function createFakeContext(sampleRate = 48000) {
  const created: FakeNode[] = [];
  const track = (node: FakeNode) => {
    created.push(node);
    return node;
  };
  const node = (type: string, extra: Record<string, unknown> = {}): FakeNode =>
    track({ __type: type, connect: vi.fn(), disconnect: vi.fn(), ...extra });

  const ctx = {
    sampleRate,
    created,
    createStereoPanner: () => node("stereoPanner", { pan: makeParam() }),
    createBiquadFilter: () =>
      node("biquad", {
        type: "",
        frequency: makeParam(),
        Q: { value: 1 },
        gain: makeParam(),
      }),
    createDynamicsCompressor: () =>
      node("compressor", {
        threshold: makeParam(),
        ratio: makeParam(),
        attack: makeParam(),
        release: makeParam(),
        knee: makeParam(),
      }),
    createGain: () => node("gain", { gain: makeParam() }),
    createConvolver: () => node("convolver", { buffer: null }),
    createDelay: () => node("delay", { delayTime: makeParam() }),
    createBuffer: (channels: number, length: number, sr: number) => {
      const data = Array.from(
        { length: channels },
        () => new Float32Array(length),
      );
      return {
        numberOfChannels: channels,
        length,
        sampleRate: sr,
        getChannelData: (c: number) => data[c],
      };
    },
  };
  return ctx as unknown as BaseAudioContext & { created: FakeNode[] };
}

function fx(
  type: string,
  parameters: Record<string, unknown>,
  isEnabled = true,
): AudioEffectTransform {
  return { id: type, type, isEnabled, parameters } as AudioEffectTransform;
}

const spline = (points: Array<{ time: number; value: number }>): ScalarParameter =>
  ({ type: "spline", points }) as ScalarParameter;

const window: AudioEffectAutomationWindow = {
  startContextTime: 0,
  wallDurationSeconds: 1,
  startTargetTicks: 0,
  windowTicks: 1000,
  sampleCount: 8,
  localTickAt: (t) => t,
};

describe("getAudioEffectTransforms / signature", () => {
  it("keeps only enabled audio-effect transforms in order", () => {
    const clip = {
      transformations: [
        { id: "v", type: "volume", isEnabled: true, parameters: { gain: 1 } },
        { id: "p", type: "pan", isEnabled: true, parameters: { pan: 0 } },
        {
          id: "e",
          type: "audioEq",
          isEnabled: false,
          parameters: {},
        },
        {
          id: "pos",
          type: "position",
          isEnabled: true,
          parameters: {},
        },
        { id: "r", type: "reverb", isEnabled: true, parameters: { mix: 0.3 } },
      ],
    } as unknown as TimelineClip;

    const result = getAudioEffectTransforms(clip);
    expect(result.map((t) => t.type)).toEqual(["pan", "reverb"]);
    expect(computeAudioEffectSignature(result)).toBe("pan>reverb");
  });
});

describe("buildAudioEffectChain", () => {
  it("returns null when there are no audio effects", () => {
    const ctx = createFakeContext();
    expect(buildAudioEffectChain(ctx, [])).toBeNull();
  });

  it("builds a single pan node where input === output", () => {
    const ctx = createFakeContext();
    const chain = buildAudioEffectChain(ctx, [fx("pan", { pan: 0 })]);
    expect(chain).not.toBeNull();
    expect((chain!.inputNode as unknown as FakeNode).__type).toBe(
      "stereoPanner",
    );
    expect(chain!.inputNode).toBe(chain!.outputNode);
  });

  it("connects multiple effects in series", () => {
    const ctx = createFakeContext();
    const chain = buildAudioEffectChain(ctx, [
      fx("pan", { pan: 0 }),
      fx("compressor", { threshold: -24, ratio: 4 }),
    ])!;
    const pan = chain.inputNode as unknown as FakeNode;
    expect(pan.__type).toBe("stereoPanner");
    // pan output is wired into the compressor's input node
    expect(pan.connect).toHaveBeenCalledTimes(1);
    expect((chain.outputNode as unknown as FakeNode).__type).toBe("gain"); // makeup gain
  });

  it("schedules constant params with setValueAtTime", () => {
    const ctx = createFakeContext();
    const chain = buildAudioEffectChain(ctx, [fx("pan", { pan: 0.5 })])!;
    chain.scheduleAutomation(window);
    const pan = chain.inputNode as unknown as FakeNode;
    const param = pan.pan as ReturnType<typeof makeParam>;
    expect(param.setValueAtTime).toHaveBeenCalledWith(0.5, 0);
    expect(param.setValueCurveAtTime).not.toHaveBeenCalled();
  });

  it("schedules splined params with a value curve", () => {
    const ctx = createFakeContext();
    const chain = buildAudioEffectChain(ctx, [
      fx("pan", {
        pan: spline([
          { time: 0, value: -1 },
          { time: 1000, value: 1 },
        ]),
      }),
    ])!;
    chain.scheduleAutomation(window);
    const pan = chain.inputNode as unknown as FakeNode;
    const param = pan.pan as ReturnType<typeof makeParam>;
    expect(param.setValueCurveAtTime).toHaveBeenCalledTimes(1);
    const [curve, start, dur] = param.setValueCurveAtTime.mock.calls[0];
    expect(curve).toBeInstanceOf(Float32Array);
    expect((curve as Float32Array).length).toBe(window.sampleCount);
    expect(start).toBe(0);
    expect(dur).toBe(1);
  });

  it("disposes by disconnecting all nodes", () => {
    const ctx = createFakeContext();
    const chain = buildAudioEffectChain(ctx, [fx("delay", { time: 0.3 })])!;
    chain.dispose();
    for (const n of ctx.created) {
      expect(n.disconnect).toHaveBeenCalled();
    }
    // idempotent
    expect(() => chain.dispose()).not.toThrow();
  });
});

describe("getReverbImpulseResponse", () => {
  it("is deterministic and cached for identical (sampleRate, decay)", () => {
    const a = getReverbImpulseResponse(createFakeContext(48000), 2);
    const b = getReverbImpulseResponse(createFakeContext(48000), 2);
    // same cache entry returned across contexts of equal sample rate
    expect(a).toBe(b);
    expect(a.length).toBe(48000 * 2);
    expect(Array.from(a.getChannelData(0).slice(0, 4))).toEqual(
      Array.from(b.getChannelData(0).slice(0, 4)),
    );
  });

  it("produces a decaying tail (start louder than end)", () => {
    const ir = getReverbImpulseResponse(createFakeContext(8000), 1);
    const ch = ir.getChannelData(0);
    const head = Math.abs(ch[0]);
    const tail = Math.abs(ch[ch.length - 1]);
    expect(head).toBeGreaterThanOrEqual(tail);
  });
});
