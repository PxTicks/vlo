# Refine Details

Use **Video → Enhance → LTX2.5 Refine Details** to rebuild fine texture in soft,
compressed, or generated video. Select the source clip, choose an output size,
and generate. The source video supplies the reference frames; its audio and
frame rate pass through to the output.

**Output size** follows the source aspect ratio, rounded to model-compatible
multiples of 32. FullHD, 4K, and 8K describe resolution tiers rather than a fixed
16:9 canvas. The default is 4K. The saved video keeps the generated resolution.

Keep **Look and texture** about sharpness, texture, grain, lighting, and colour.
Avoid naming people or objects: every tile sees the same prompt and can paint a
named subject into the wrong part of the frame. Start with the supplied prompt
and negative prompt. Do not sharpen or denoise the source first.

The trained tile is **1024 × 576**. For portrait footage, swap **Tile width** and
**Tile height** to **576 × 1024**. Keep the 50% overlap and the eight-step Euler
schedule in the graph. Tiled sampling and tiled VAE decoding are both enabled.

**Temporal window (frames)** controls memory use. The default is 97; lowering it
processes shorter overlapping windows. One control drives both the video guide
and sampler. Timeline selections use `8n+1` frames, up to 481 per job. Start with
a short shot: spatial tiling limits memory per tile but high-resolution clips
can still take substantial time and memory.

For damaged archival footage, run **Restore** first at FullHD, then refine that
result at 4K. For 8K delivery, refine to 4K before a separate 8K pass. Refine
reconstructs detail; very small text, faces, and logos may change. Pristine
camera footage can become softer as grain is removed.

These workflows reuse Vlo's LTX inpainting model loaders, memory video input,
and video saver, with the official LTX tiled video-reference conditioning and
fusion sampler. The default profile uses the same Int8 model and text encoder
as Vlo's other LTX workflows; the high-VRAM profile uses its existing BF16 stack.
The adapter appears in the workflow model downloads. Accept its Hugging Face
access terms and configure your download token if it is not already installed.

Requires an updated **ComfyUI-LTXVideo** providing `LTXVTiledFusionSampler`,
`LTXVGetTilingSizes`, and the streaming inputs on `LTXAddVideoICLoRAGuide`.
If these nodes or inputs are missing, update that node pack and restart ComfyUI.

[Official Refine model and settings](https://huggingface.co/Lightricks/LTX-2.5-22b-IC-LoRA-Refine-Details)
· [Source workflow](https://github.com/Lightricks/ComfyUI-LTXVideo/blob/44c8a36b7c31ee00b4271daed11dc2a4aa481140/example_workflows/2.5/LTX-2.5_V2V_TiledFusion_Upscale.json)
