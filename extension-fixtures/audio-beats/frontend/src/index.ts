import type {
  ExtensionAudioClipSnapshot,
  ExtensionModule,
  ExtensionTimelineTransactionResult,
} from "@vlo/extension-sdk";

const TRANSIENT_THRESHOLD = 0.8;
const MIN_TRANSIENT_GAP_SECONDS = 0.2;

interface AudioBeatState {
  effectId: string | null;
  sourceTicks: number[];
  splitTicks: number[];
  transaction: ExtensionTimelineTransactionResult | null;
}

const state: AudioBeatState = {
  effectId: null,
  sourceTicks: [],
  splitTicks: [],
  transaction: null,
};

export function getAudioBeatStateForConformance(): Readonly<AudioBeatState> {
  return state;
}

export function resetAudioBeatStateForConformance(): void {
  state.effectId = null;
  state.sourceTicks = [];
  state.splitTicks = [];
  state.transaction = null;
}

/** Rising-edge transient detector over planar PCM. */
export function detectTransientSourceTicks(
  channels: readonly Float32Array[],
  sampleRate: number,
  startSeconds: number,
  ticksPerSecond: number,
): number[] {
  const length = channels.reduce(
    (minimum, channel) => Math.min(minimum, channel.length),
    Number.POSITIVE_INFINITY,
  );
  if (!Number.isFinite(length) || length <= 0) return [];

  const minimumGapFrames = Math.round(sampleRate * MIN_TRANSIENT_GAP_SECONDS);
  const ticks: number[] = [];
  let previousAbove = false;
  let lastFrame = -minimumGapFrames;
  for (let frame = 0; frame < length; frame += 1) {
    let amplitude = 0;
    for (const channel of channels) {
      amplitude = Math.max(amplitude, Math.abs(channel[frame] ?? 0));
    }
    const above = amplitude >= TRANSIENT_THRESHOLD;
    if (above && !previousAbove && frame - lastFrame >= minimumGapFrames) {
      ticks.push(
        Math.round((startSeconds + frame / sampleRate) * ticksPerSecond),
      );
      lastFrame = frame;
    }
    previousAbove = above;
  }
  return ticks;
}

function mapSourceTicksToSplitTicks(
  clip: ExtensionAudioClipSnapshot,
  sourceTicks: readonly number[],
  sourceTicksToClipProgress: (clipId: string, sourceTicks: number) => number,
): number[] {
  const clipEnd = clip.startTicks + clip.durationTicks;
  return sourceTicks
    .map((sourceTick) =>
      Math.round(
        clip.startTicks +
          sourceTicksToClipProgress(clip.id, sourceTick) * clip.durationTicks,
      ),
    )
    .filter((tick) => tick > clip.startTicks && tick < clipEnd)
    .filter((tick, index, all) => all.indexOf(tick) === index)
    .sort((left, right) => right - left);
}

export const activate: ExtensionModule["activate"] = (context) => {
  const { audio, timeline, transformations } = context.api;
  const { commands } = context.api.ui;

  const compressor = transformations.register({
    id: "transient-compressor",
    apiVersion: 1,
    kind: "trusted-audio-effect",
    label: "Transient Compressor",
    maxTailSeconds: 0.1,
    groups: [
      {
        id: "dynamics",
        title: "Dynamics",
        controls: [
          {
            type: "slider",
            name: "threshold",
            label: "Threshold",
            defaultValue: -12,
            min: -60,
            max: 0,
            step: 0.5,
            supportsSpline: true,
          },
        ],
      },
    ],
    createEffect: (audioContext) => {
      const node = audioContext.createDynamicsCompressor();
      return {
        inputNode: node,
        outputNode: node,
        apply: (_parameters, render) => {
          const threshold = render.resolveParameter(
            "threshold",
            render.startPresentationTimeTicks,
          );
          if (typeof threshold === "number") {
            node.threshold.setValueAtTime(
              threshold,
              render.startContextTime,
            );
          }
        },
      };
    },
  });
  state.effectId = compressor.id;

  commands.register({
    id: "analyse-and-split-transients",
    apiVersion: 1,
    title: "Analyse and split the first audio clip",
    when: { key: "project.open" },
    run: async () => {
      const clip = audio.listClips()[0];
      if (!clip) return;

      const inspected = await audio.inspect(clip.assetId, {
        signal: context.signal,
      });
      if (!inspected.ok) {
        context.logger.warn("Audio source inspection was refused", inspected);
        return;
      }
      const sourceStartSeconds =
        clip.sourceOffsetTicks / timeline.ticksPerSecond;
      const sourceDurationSeconds =
        clip.croppedSourceDurationTicks / timeline.ticksPerSecond;
      const maximumReadSeconds =
        inspected.source.maxPcmFramesPerRead / inspected.source.sampleRate;
      const pcm = await audio.readPcm(clip.assetId, {
        startSeconds: sourceStartSeconds,
        endSeconds:
          sourceStartSeconds +
          Math.min(sourceDurationSeconds, maximumReadSeconds),
        signal: context.signal,
      });
      if (!pcm.ok) {
        context.logger.warn("Audio analysis was refused", pcm);
        return;
      }

      state.sourceTicks = detectTransientSourceTicks(
        pcm.channels,
        pcm.source.sampleRate,
        pcm.startSeconds,
        timeline.ticksPerSecond,
      );
      state.splitTicks = mapSourceTicksToSplitTicks(
        clip,
        state.sourceTicks,
        timeline.sourceTicksToClipProgress,
      );
      if (state.splitTicks.length === 0) return;

      // Descending order keeps the original left-hand clip valid after every
      // split, so all detected cuts fit in one atomic undo entry.
      state.transaction = timeline.transaction(
        "Split audio at detected transients",
        (transaction) => {
          for (const tick of state.splitTicks) {
            transaction.splitClip(clip.id, tick);
          }
        },
      );
    },
  });
};
