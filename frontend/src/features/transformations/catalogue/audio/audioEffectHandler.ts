import type { TransformHandler } from "../types";

// Shared no-op visual handler for audio-effect transforms.
//
// Like Volume and Speed, audio effects are realized in the Audio Renderer
// (see renderer/services/audioEffectChain.ts), not the Pixi visual pass, so the
// visual state is left untouched.
export const audioEffectHandler: TransformHandler = () => {
  // No visual changes to state.
};
