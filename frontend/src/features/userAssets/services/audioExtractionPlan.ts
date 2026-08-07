import {
  FlacOutputFormat,
  Mp3OutputFormat,
  Mp4OutputFormat,
  OggOutputFormat,
  WavOutputFormat,
  type AudioCodec,
  type OutputFormat,
} from "mediabunny";

export interface ExtractedAudioOutputSpec {
  extension: string;
  mimeType: string;
  createFormat: () => OutputFormat;
}

const PRIMARY_AUDIO_OUTPUT_SPECS = {
  mp3: {
    extension: "mp3",
    mimeType: "audio/mpeg",
    createFormat: () => new Mp3OutputFormat(),
  },
  flac: {
    extension: "flac",
    mimeType: "audio/flac",
    createFormat: () => new FlacOutputFormat(),
  },
  wav: {
    extension: "wav",
    mimeType: "audio/wav",
    createFormat: () => new WavOutputFormat(),
  },
  ogg: {
    extension: "ogg",
    mimeType: "audio/ogg",
    createFormat: () => new OggOutputFormat(),
  },
  mp4: {
    extension: "m4a",
    mimeType: "audio/mp4",
    createFormat: () => new Mp4OutputFormat(),
  },
} as const satisfies Record<string, ExtractedAudioOutputSpec>;

export function resolvePrimaryAudioOutputSpec(
  codec: string | null | undefined,
): ExtractedAudioOutputSpec | null {
  switch (codec) {
    case "mp3":
      return PRIMARY_AUDIO_OUTPUT_SPECS.mp3;
    case "flac":
      return PRIMARY_AUDIO_OUTPUT_SPECS.flac;
    case "opus":
    case "vorbis":
      return PRIMARY_AUDIO_OUTPUT_SPECS.ogg;
    case "pcm-s16":
    case "pcm-s24":
    case "pcm-s32":
    case "pcm-f32":
    case "pcm-u8":
    case "ulaw":
    case "alaw":
      return PRIMARY_AUDIO_OUTPUT_SPECS.wav;
    case "aac":
    case "ac3":
    case "eac3":
    case "pcm-s16be":
    case "pcm-s24be":
    case "pcm-s32be":
    case "pcm-f32be":
    case "pcm-f64":
    case "pcm-f64be":
      return PRIMARY_AUDIO_OUTPUT_SPECS.mp4;
    default:
      return null;
  }
}

export function resolveAudioExtractionPlan(
  codec: string | null | undefined,
): {
  outputSpec: ExtractedAudioOutputSpec;
  targetCodec: AudioCodec;
  preservesSourceCodec: boolean;
} {
  const outputSpec = resolvePrimaryAudioOutputSpec(codec);
  if (outputSpec && codec) {
    return {
      outputSpec,
      targetCodec: codec as AudioCodec,
      preservesSourceCodec: true,
    };
  }

  return {
    outputSpec: PRIMARY_AUDIO_OUTPUT_SPECS.wav,
    targetCodec: "pcm-s16",
    preservesSourceCodec: false,
  };
}
