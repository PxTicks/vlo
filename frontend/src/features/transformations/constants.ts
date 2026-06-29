export const AUDIO_COMPRESSOR_DEFAULTS = {
  threshold: 0,
  ratio: 1,
  attack: 0.003,
  release: 0.25,
  knee: 0,
  makeup: 1,
} as const;

export const AUDIO_REVERB_DEFAULTS = {
  mix: 0,
  decay: 2,
} as const;

export const AUDIO_DELAY_DEFAULTS = {
  time: 0.3,
  feedback: 0,
  mix: 0,
} as const;
