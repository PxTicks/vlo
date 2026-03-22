/**
 * Frame+audio stitching into an MP4 video for the generation pipeline.
 */

import {
  Output,
  Mp4OutputFormat,
  BufferTarget,
  CanvasSource,
  AudioBufferSource,
} from "mediabunny";
import { sortFrameFilesBySequence } from "./files";
import { toPositiveFps } from "./fps";
import { createOutputCanvas, isCanvas2DContext } from "./media";

export async function decodeAudioBuffer(file: File): Promise<AudioBuffer> {
  const AudioContextCtor =
    globalThis.AudioContext ??
    (globalThis as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioContextCtor) {
    throw new Error("AudioContext is unavailable");
  }

  const context = new AudioContextCtor({ sampleRate: 48000 });
  try {
    const audioBytes = await file.arrayBuffer();
    return await context.decodeAudioData(audioBytes.slice(0));
  } finally {
    await context.close();
  }
}

export async function packageFramesAndAudioToVideo(
  frameFiles: File[],
  audioFile: File | null,
  fps: number,
): Promise<File> {
  if (frameFiles.length === 0) {
    throw new Error("No frame files were provided for packaging");
  }

  const orderedFrames = sortFrameFilesBySequence(frameFiles);
  const firstBitmap = await createImageBitmap(orderedFrames[0]);
  const width = firstBitmap.width;
  const height = firstBitmap.height;
  firstBitmap.close();

  const canvas = createOutputCanvas(width, height);
  const context2dRaw = canvas.getContext("2d");
  if (!isCanvas2DContext(context2dRaw)) {
    throw new Error("Failed to acquire a 2D canvas context for packaging");
  }
  const context2d = context2dRaw;

  const bufferTarget = new BufferTarget();
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: "in-memory" }),
    target: bufferTarget,
  });

  const videoSource = new CanvasSource(canvas, {
    codec: "avc",
    bitrate: 6_000_000,
    latencyMode: "quality",
  });
  const audioSource = audioFile
    ? new AudioBufferSource({
        codec: "opus",
        bitrate: 128_000,
      })
    : null;

  const safeFps = toPositiveFps(fps) ?? 1;
  await output.addVideoTrack(videoSource, { frameRate: safeFps });
  if (audioSource) {
    await output.addAudioTrack(audioSource);
  }
  await output.start();

  if (audioSource && audioFile) {
    const audioBuffer = await decodeAudioBuffer(audioFile);
    await audioSource.add(audioBuffer);
    await audioSource.close();
  }

  for (
    let frameIndex = 0;
    frameIndex < orderedFrames.length;
    frameIndex += 1
  ) {
    const frameBitmap = await createImageBitmap(orderedFrames[frameIndex]);
    context2d.clearRect(0, 0, width, height);
    context2d.drawImage(frameBitmap, 0, 0, width, height);
    frameBitmap.close();
    await videoSource.add(frameIndex / safeFps, 1 / safeFps);
  }

  await videoSource.close();
  await output.finalize();

  if (!bufferTarget.buffer) {
    throw new Error("Packaged video output buffer is empty");
  }

  return new File(
    [bufferTarget.buffer],
    `generation-packaged-${Date.now()}.mp4`,
    {
      type: "video/mp4",
      lastModified: Date.now(),
    },
  );
}
