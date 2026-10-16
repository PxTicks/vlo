# Restore

Use **Video → Enhance → LTX2.5 Restore** for damaged archive footage, tape or
broadcast transfers, and heavily compressed clips. Select the source video,
start with **FullHD**, and generate. The video itself supplies the reference;
its audio and frame rate pass through to the output.

Restore rebuilds texture, removes compression damage and casts, and can
colourise monochrome material. It is a strong restoration pass: inferred
colours and missing details may differ from the original scene. For clean or
generated footage, start with **Refine Details** instead.

The output follows the source aspect ratio, rounded to multiples of 32. Vlo
renders timeline selections at the project's aspect ratio, so a 4:3 scan in a
16:9 project arrives pillarboxed and the bars are processed with the picture.
Restore 4:3 material in a 4:3 project. FullHD is a tier based on the source's
long edge rather than a forced widescreen canvas, so 4:3 lands at 1920 × 1440.
That is larger than the model card's 1440 × 1088 working canvas and takes
roughly two and a half times as many tiles. Deinterlace interlaced or
telecined sources before using this workflow. Do not denoise or sharpen first.

The trained tile is **960 × 544**. For portrait footage, swap **Tile width** and
**Tile height** to **544 × 960**. Keep the 50% overlap and eight-step Euler
schedule. **Temporal window (frames)** defaults to 97 and drives both the
streaming video guide and sampler; lower it to reduce memory use. Timeline
selections use `8n+1` frames, up to 481 per job. Start with a short shot and check
colour consistency across temporal windows before processing longer sections.

Colour is inferred from what the prompt says the scene is, so use **Scene and
period** to describe the era, place, light, materials, and what people wear,
for example "1950s living room, soft window light, printed cotton dress,
natural colour". Keep it true of the whole frame: every tile receives the same
prompt, so a specific object named there can be painted into tiles that do not
contain it. Put anything the model must not invent in the negative prompt, such
as modern vehicles, signage, lettering, or logos. Empty regions of a scan are
then rebuilt as period-plausible background. On footage that already has
colour, keep the prompt neutral about colour.

For the recommended two-pass enhancement, restore at FullHD, then pass that
result into **Refine Details** at 4K. Both workflows use the same tiled
conditioning, sampling, and delivery path, with task-specific adapters and
tile sizes. Higher output sizes are available, but refining separately is the
recommended detail stage after restoration.

Vlo reuses its LTX inpainting model loaders, memory video input, and video saver.
The default profile uses the existing Int8 LTX model stack; the high-VRAM
profile uses BF16. Although this restoration adapter was trained on LTX 2.3,
its official model card explicitly supports the LTX 2.5 distilled stack.
Accept the adapter's Hugging Face access terms and configure your download
token to download it through Vlo's workflow model downloads.

Requires an updated **ComfyUI-LTXVideo** providing `LTXVTiledFusionSampler`,
`LTXVGetTilingSizes`, and streaming `LTXAddVideoICLoRAGuide` inputs. Update the
node pack and restart ComfyUI if those nodes or inputs are missing.

[Official Restore model and settings](https://huggingface.co/Lightricks/LTX-2.5-22b-IC-LoRA-Restore)
· [Source workflow](https://github.com/Lightricks/ComfyUI-LTXVideo/blob/44c8a36b7c31ee00b4271daed11dc2a4aa481140/example_workflows/2.5/LTX-2.5_V2V_TiledFusion_Upscale.json)
