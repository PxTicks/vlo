#!/usr/bin/env python3
"""Regenerate the checked-in export parity fixtures.

Writes the mask/grade editor project folder the browser-media e2e lane opens
(``frontend/e2e/fixtures/project_mask_grade``) and the pixel expectations every
render host is held to (``shared/fixtures/export-parity``). The editor's export
and a detached render of the same saved documents must both meet them.

Needs PyAV, NumPy and Pillow, which the backend venv has. From the repository
root:

    backend/.venv/bin/python scripts/generate_export_parity_fixtures.py
"""

from __future__ import annotations

import json
import math
import shutil
import wave
from pathlib import Path

import av
import numpy as np

REPOSITORY = Path(__file__).resolve().parents[1]
PROJECT = REPOSITORY / "frontend/e2e/fixtures/project_mask_grade"
SHARED = REPOSITORY / "shared/fixtures/export-parity"

TICKS_PER_SECOND = 96_000
#: Media are authored at the output size.
MEDIA_OUTPUT_SIZE = (320, 180)
BACKDROP_COLOR = (30, 180, 60)


#: A saved project exercising the core-v1 additions with decodable media:
#: an asset-backed video mask, a brush mask, a LUT grade and an adjustment
#: layer. It is checked in as an editor project folder
#: (frontend/e2e/fixtures/project_mask_grade), so the editor's browser export
#: and a detached render of the same saved documents are held to the
#: same expectations (shared/fixtures/export-parity). Regenerate with
#: scripts/generate_export_parity_fixtures.py.
MASK_PROJECT_FPS = 30
MASK_PROJECT_SECONDS = 4
#: The output short edge; media are authored at the output size and fitted
#: to the fixed-height logical stage, so content pixels map to output pixels.
MASK_OUTPUT_RESOLUTION = 180
PLATE_COLOR = (40, 60, 200)
CARD_COLOR = (230, 200, 40)
#: The stage is split at this output column by the plate's matte.
MATTE_SPLIT = 160
#: The brush's painted rectangle, in the card's own (output-sized) pixels.
BRUSH_BOUNDS = (110, 60, 100, 60)
PLATE_SECONDS = (0.0, 1.0)
CARD_SECONDS = (1.0, 2.0)
DIM_SECONDS = (1.5, 2.0)
DIM_BRIGHTNESS = 0.5
#: 2-3 s: a white panel shown through two rectangle masks joined by a union,
#: dimmed by an effect-masked brightness filter only inside the left one.
SHAPES_SECONDS = (2.0, 3.0)
PANEL_COLOR = (235, 235, 235)
#: Each rectangle mask (200 px base, scaled) in the panel's own content
#: pixels, centre-origin: masks follow their clip, not the stage. The panel is
#: authored at the output size, so these map 1:1 onto output pixels:
#: left spans x 40-120, right 200-280, both y 30-150.
LEFT_RECT = dict(x=-80, y=0, scale=(0.4, 0.6))
RIGHT_RECT = dict(x=80, y=0, scale=(0.4, 0.6))
EFFECT_BRIGHTNESS = 0.5
#: 3-4 s: a badge keyframed across the stage, a subject shown through a
#: SAM2 mask (right half) grown outward, and a greyscale layer from 3.5 s.
MOTION_SECONDS = (3.0, 4.0)
BADGE_TRAVEL = (-600, 600)
BADGE_COLOR = (230, 30, 30)
SUBJECT_COLOR = (250, 140, 20)
SAM2_SPLIT = 200
SAM2_GROW = 20
#: New SAM2 masks are stored as a truncated signed distance band, level
#: 127.5 - 8 * d with d in pixels, negative inside (backend sam2_distance.py).
SAM2_DISTANCE_ZERO_LEVEL = 127.5
SAM2_DISTANCE_LEVELS_PER_PIXEL = 8
GREY_SECONDS = (3.5, 4.0)
MASK_PROJECT_ID = "mask-grade-project"
#: A tone under the whole timeline, so an export's audio path (and a detached
#: realm's AAC encoder) is exercised too. Checked as a peak level.
TONE_FREQUENCY = 440
TONE_AMPLITUDE = 0.5


def _write_solid_video(path: Path, size: tuple[int, int], fps: int, frames: int, paint) -> None:
    width, height = size
    with av.open(str(path), "w") as container:
        stream = container.add_stream("libx264", rate=fps)
        stream.width, stream.height, stream.pix_fmt = width, height, "yuv420p"
        stream.options = {"crf": "10", "preset": "ultrafast"}
        for index in range(frames):
            pixels = np.zeros((height, width, 3), dtype=np.uint8)
            paint(pixels, index)
            for packet in stream.encode(av.VideoFrame.from_ndarray(pixels, format="rgb24")):
                container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)


def _write_tone(path: Path, *, frequency: float, amplitude: float, seconds: int) -> None:
    samples = np.arange(48_000 * seconds)
    wave_ = (np.sin(samples * 2 * math.pi * frequency / 48_000) * amplitude * 32767).astype("<i2")
    with wave.open(str(path), "wb") as writer:
        writer.setnchannels(2)
        writer.setsampwidth(2)
        writer.setframerate(48_000)
        writer.writeframes(np.repeat(wave_[:, None], 2, axis=1).tobytes())


def inverting_cube_lut(size: int = 2) -> str:
    """A LUT whose output is the complement of its input: unmistakable in pixels."""
    lines = ['TITLE "invert"', f"LUT_3D_SIZE {size}"]
    steps = [index / (size - 1) for index in range(size)]
    for blue in steps:
        for green in steps:
            for red in steps:  # red varies fastest, as .cube specifies
                lines.append(f"{1 - red:.6f} {1 - green:.6f} {1 - blue:.6f}")
    return "\n".join(lines) + "\n"


def write_mask_grade_project(project: Path) -> None:
    """Write the media and the saved editor documents of the mask/grade project.

    Bottom to top: a backdrop graded through an inverting LUT for the whole
    timeline; a plate masked by a generated matte (left half) and then a card
    masked by a painted brush rectangle; and an adjustment layer that dims
    everything below it for the last half second.
    """
    from PIL import Image

    metadata = project / ".vloproject"
    assets, masks = project / "assets", metadata / "masks"
    assets.mkdir(parents=True, exist_ok=True)
    masks.mkdir(parents=True, exist_ok=True)
    size = MEDIA_OUTPUT_SIZE
    width, height = size
    video_fps, video_frames = 24, 24 * MASK_PROJECT_SECONDS

    def plate(pixels: np.ndarray, _index: int) -> None:
        pixels[:] = PLATE_COLOR

    def matte(pixels: np.ndarray, _index: int) -> None:
        pixels[:, :MATTE_SPLIT] = 255

    _write_solid_video(assets / "plate.mp4", size, video_fps, video_frames, plate)
    _write_solid_video(masks / "matte.mp4", size, video_fps, video_frames, matte)
    Image.new("RGB", size, BACKDROP_COLOR).save(assets / "backdrop.png")
    Image.new("RGB", size, CARD_COLOR).save(assets / "card.png")
    brush_x, brush_y, brush_width, brush_height = BRUSH_BOUNDS
    Image.new("RGB", (brush_width, brush_height), (255, 0, 0)).save(masks / "brush.png")
    (assets / "invert.cube").write_text(inverting_cube_lut())
    Image.new("RGB", size, PANEL_COLOR).save(assets / "panel.png")
    badge = Image.new("RGBA", size, (0, 0, 0, 0))
    badge.paste(BADGE_COLOR + (255,), (width // 2 - 16, height // 2 - 16, width // 2 + 16, height // 2 + 16))
    badge.save(assets / "badge.png")

    def subject(pixels: np.ndarray, _index: int) -> None:
        pixels[:] = SUBJECT_COLOR

    def sam2_matte(pixels: np.ndarray, _index: int) -> None:
        # Distance from each pixel centre to the edge at x = SAM2_SPLIT.
        signed = SAM2_SPLIT - (np.arange(width) + 0.5)
        levels = np.clip(
            np.round(SAM2_DISTANCE_ZERO_LEVEL - SAM2_DISTANCE_LEVELS_PER_PIXEL * signed), 0, 255
        ).astype(np.uint8)
        pixels[:] = levels[None, :, None]

    _write_solid_video(assets / "subject.mp4", size, video_fps, video_frames, subject)
    _write_solid_video(masks / "subject_sam2.mp4", size, video_fps, video_frames, sam2_matte)
    _write_tone(assets / "tone.wav", frequency=TONE_FREQUENCY, amplitude=TONE_AMPLITUDE,
                seconds=MASK_PROJECT_SECONDS)

    def ticks(seconds: float) -> int:
        return round(seconds * TICKS_PER_SECOND)

    duration = ticks(MASK_PROJECT_SECONDS)
    source = ticks(video_frames / video_fps)

    def track(identity: str, kind: str) -> dict[str, object]:
        return dict(id=identity, type=kind, label=identity, isVisible=True, isMuted=False, isLocked=False)

    def timing(start: float, end: float, *, source_ticks: int | None) -> dict[str, object]:
        length = ticks(end) - ticks(start)
        return dict(start=ticks(start), sourceDuration=source_ticks,
                    transformedDuration=source_ticks if source_ticks is not None else length,
                    transformedOffset=0, timelineDuration=length, croppedSourceDuration=length, offset=0)

    def fit(identity: str) -> dict[str, object]:
        return dict(id=f"{identity}-fit", type="fitMode", isEnabled=True, parameters=dict(fitMode="contain"))

    def mask(parent: str, local: str, track_id: str, clip_timing: dict[str, object], **fields: object) -> dict[str, object]:
        return dict(id=f"{parent}::mask::{local}", type="mask", name=local, parentClipId=parent,
                    trackId=track_id, maskMode="apply", maskInverted=False,
                    **clip_timing, **{"transformations": [], **fields})

    def masked_by(local: str, parent: str) -> list[dict[str, object]]:
        return [
            dict(id=f"{parent}-ref", type="mask_ref", parameters=dict(maskClipId=f"{parent}::mask::{local}")),
            dict(id=f"{parent}-composition", type="mask_composition", parameters=dict(
                expression=dict(kind="mask_ref", maskId=local), algebra="normal", compositeTransformations=[])),
        ]

    def rectangle(parent: str, local: str, clip_timing: dict[str, object], placement: dict) -> dict[str, object]:
        scale_x, scale_y = placement["scale"]
        return mask(parent, local, "overlay", clip_timing, maskType="rectangle",
                    maskParameters=dict(baseWidth=200, baseHeight=200), transformations=[
                        dict(id=f"{local}-position", type="position", isEnabled=True,
                             parameters=dict(x=placement["x"], y=placement["y"])),
                        dict(id=f"{local}-scale", type="scale", isEnabled=True,
                             parameters=dict(x=scale_x, y=scale_y, isLinked=False)),
                        dict(id=f"{local}-rotation", type="rotation", isEnabled=True, parameters=dict(angle=0)),
                    ])

    def shape_and_motion_clips() -> list[dict[str, object]]:
        shapes = timing(*SHAPES_SECONDS, source_ticks=None)
        motion_start, motion_end = (ticks(value) for value in MOTION_SECONDS)
        motion = timing(*MOTION_SECONDS, source_ticks=None)
        subject_timing = {**timing(*MOTION_SECONDS, source_ticks=source)}
        grey_length = ticks(GREY_SECONDS[1]) - ticks(GREY_SECONDS[0])
        start_x, end_x = BADGE_TRAVEL
        return [
            dict(id="grey", type="adjustment", name="grey", trackId="dim", depth="all", retimingMode="static",
                 **timing(*GREY_SECONDS, source_ticks=grey_length),
                 transformations=[dict(id="grey-hsl", type="filter", filterName="HslAdjustmentFilter",
                                       isEnabled=True, parameters=dict(hue=0, saturation=-1, lightness=0, alpha=1))]),
            dict(id="panel", assetId="panel", type="image", name="panel", trackId="overlay", **shapes,
                 components=[
                     dict(id="panel-ref-left", type="mask_ref", parameters=dict(maskClipId="panel::mask::left")),
                     dict(id="panel-ref-right", type="mask_ref", parameters=dict(maskClipId="panel::mask::right")),
                     dict(id="panel-composition", type="mask_composition", parameters=dict(
                         expression=dict(kind="operation", operator="union",
                                         left=dict(kind="mask_ref", maskId="left"),
                                         right=dict(kind="mask_ref", maskId="right")),
                         algebra="normal", compositeTransformations=[])),
                 ],
                 transformations=[
                     fit("panel"),
                     dict(id="panel-dim", type="filter", filterName="AdjustmentFilter", isEnabled=True,
                          parameters=dict(brightness=EFFECT_BRIGHTNESS),
                          effectMask=dict(enabled=True, mode="composite",
                                          expression=dict(kind="mask_ref", maskId="left"))),
                 ]),
            rectangle("panel", "left", shapes, LEFT_RECT),
            rectangle("panel", "right", shapes, RIGHT_RECT),
            dict(id="badge", assetId="badge", type="image", name="badge", trackId="badges", **motion,
                 transformations=[
                     fit("badge"),
                     # Keyframes sit at source time, which for a still starts at zero.
                     dict(id="badge-position", type="position", isEnabled=True,
                          keyframeTimes=[0, motion_end - motion_start],
                          parameters=dict(x=dict(type="spline", points=[
                              dict(time=0, value=start_x), dict(time=motion_end - motion_start, value=end_x)]), y=0)),
                 ]),
            dict(id="subject", assetId="subject", type="video", name="subject", trackId="overlay", **subject_timing,
                 components=masked_by("sam", "subject"), transformations=[fit("subject")]),
            mask("subject", "sam", "overlay", subject_timing, maskType="sam2", sam2GrowAmount=SAM2_GROW,
                 maskParameters=dict(baseWidth=1, baseHeight=1), sam2MaskAssetId="subject-sam2",
                 sam2GeneratedPointsHash="fixture", maskPoints=[dict(x=0.8, y=0.5, label=1, timeTicks=0)]),
        ]

    plate_timing = timing(*PLATE_SECONDS, source_ticks=source)
    card_timing = timing(*CARD_SECONDS, source_ticks=None)
    dim_length = ticks(DIM_SECONDS[1]) - ticks(DIM_SECONDS[0])
    clips = [
        dict(id="dim", type="adjustment", name="dim", trackId="dim", depth="all", retimingMode="static",
             **timing(*DIM_SECONDS, source_ticks=dim_length),
             transformations=[dict(id="dim-adjust", type="filter", filterName="AdjustmentFilter", isEnabled=True,
                                   parameters=dict(brightness=DIM_BRIGHTNESS))]),
        dict(id="plate", assetId="plate", type="video", name="plate", trackId="overlay", **plate_timing,
             components=masked_by("matte", "plate"), transformations=[fit("plate")]),
        mask("plate", "matte", "overlay", plate_timing, maskType="generation",
             maskParameters=dict(baseWidth=1, baseHeight=1), generationMaskAssetId="matte"),
        dict(id="card", assetId="card", type="image", name="card", trackId="overlay", **card_timing,
             components=masked_by("brush", "card"), transformations=[fit("card")]),
        mask("card", "brush", "overlay", card_timing, maskType="brush",
             maskParameters=dict(baseWidth=width, baseHeight=height), brushMaskAssetId="brush",
             brushPaintedBounds=dict(x=brush_x, y=brush_y, width=brush_width, height=brush_height)),
        *shape_and_motion_clips(),
        dict(id="backdrop", assetId="backdrop", type="image", name="backdrop", trackId="main",
             **timing(0, MASK_PROJECT_SECONDS, source_ticks=None), transformations=[
                 fit("backdrop"),
                 dict(id="backdrop-grade", type="filter", filterName="ColorGradeFilter", isEnabled=True,
                      parameters=dict(colorModel=dict(version=1, gradingSpace="srgb-rec709"),
                                      lutAssetId="invert", lutIntensity=1)),
             ]),
        dict(id="tone", assetId="tone", type="audio", name="tone", trackId="sound",
             **timing(0, MASK_PROJECT_SECONDS, source_ticks=ticks(MASK_PROJECT_SECONDS)), transformations=[]),
    ]

    def asset(identity: str, kind: str, path: str, **fields: object) -> dict[str, object]:
        return dict(id=identity, type=kind, name=path.rsplit("/", 1)[-1], hash=f"fixture-{identity}",
                    src=path, createdAt=0, **fields)

    video = dict(duration=video_frames / video_fps, fps=float(video_fps))
    documents = {
        "project.json": dict(
            documentType="vlo.project", schemaVersion=3, id=MASK_PROJECT_ID, title="Masks and grades",
            created_at=0, last_modified=0,
            config=dict(aspectRatio="16:9", outputResolution=MASK_OUTPUT_RESOLUTION, fps=MASK_PROJECT_FPS,
                        fitMode="contain"),
            files=dict(timeline="timeline.json", assets="assets.json", composites="composites.json",
                       assetMetadataDir="asset-metadata")),
        "timeline.json": dict(
            documentType="vlo.timeline", schemaVersion=3, updated_at=0,
            tracks=[track("dim", "adjustment"), track("badges", "visual"), track("overlay", "visual"),
                    track("main", "visual"), track("sound", "audio")],
            clips=clips, transitions=[]),
        "assets.json": dict(
            documentType="vlo.assets", schemaVersion=1, updated_at=0, assetFamilies={}, assets={
                item["id"]: item for item in (
                    asset("plate", "video", "assets/plate.mp4", **video),
                    asset("matte", "video", ".vloproject/masks/matte.mp4", **video),
                    asset("card", "image", "assets/card.png"),
                    asset("brush", "image", ".vloproject/masks/brush.png"),
                    asset("backdrop", "image", "assets/backdrop.png"),
                    asset("invert", "lut", "assets/invert.cube"),
                    asset("panel", "image", "assets/panel.png"),
                    asset("badge", "image", "assets/badge.png"),
                    asset("subject", "video", "assets/subject.mp4", **video),
                    asset("subject-sam2", "video", ".vloproject/masks/subject_sam2.mp4", **video,
                          creationMetadata=dict(
                              source="sam2_mask", parentAssetId="subject", parentClipId="subject",
                              maskClipId="subject::mask::sam", pointCount=1, sourceHash="fixture-subject",
                              maskEncoding="tsdf8_k8")),
                    asset("tone", "audio", "assets/tone.wav", duration=float(MASK_PROJECT_SECONDS)),
                )}),
        "composites.json": dict(documentType="vlo.composites", schemaVersion=2, updated_at=0, composites={}),
    }
    for name, document in documents.items():
        (metadata / name).write_text(json.dumps(document, indent=2) + "\n")


def mask_grade_expectations() -> dict[str, object]:
    """What each host's output must show, as output-pixel rectangles and colours.

    Tolerances absorb 4:2:0 chroma, colour-matrix round trips and the
    renderer's sRGB/linear handling; each check still separates the colours it
    distinguishes by far more than its tolerance.
    """
    fps = MASK_PROJECT_FPS
    graded = [255 - channel for channel in BACKDROP_COLOR]
    x, y, width, height = BRUSH_BOUNDS
    card_frame, before_dim, after_dim = round(1.25 * fps), round((DIM_SECONDS[0] - 0.1) * fps), round((DIM_SECONDS[0] + 0.1) * fps)
    shapes = round(sum(SHAPES_SECONDS) / 2 * fps)
    motion_frame, grey_frame = round(MOTION_SECONDS[0] * fps), round((GREY_SECONDS[0] + 0.2) * fps)
    output_scale = MEDIA_OUTPUT_SIZE[0] / 1920  # logical stage is fixed-height 1080

    def badge_x(frame: int) -> float:
        progress = (frame - motion_frame) / fps / (MOTION_SECONDS[1] - MOTION_SECONDS[0])
        start, end = BADGE_TRAVEL
        return MEDIA_OUTPUT_SIZE[0] / 2 + (start + (end - start) * progress) * output_scale

    def sample(name: str, frame: int, rect: tuple[int, int, int, int], rgb, tolerance: int) -> dict[str, object]:
        return dict(name=name, frame=frame, rect=list(rect), rgb=[round(channel, 1) for channel in rgb], tolerance=tolerance)

    return dict(
        fps=fps, frames=fps * MASK_PROJECT_SECONDS, width=MEDIA_OUTPUT_SIZE[0], height=MEDIA_OUTPUT_SIZE[1],
        # AAC may overshoot a sine's peak slightly; silence or a doubled mix
        # both fall well outside.
        audio=dict(peak=TONE_AMPLITUDE, tolerance=0.15),
        samples=[
            sample("plate inside its matte", 15, (55, 85, 65, 95), PLATE_COLOR, 12),
            sample("plate just inside the matte edge", 15, (MATTE_SPLIT - 13, 85, MATTE_SPLIT - 3, 95), PLATE_COLOR, 12),
            sample("LUT-graded backdrop outside the matte", 15, (255, 85, 265, 95), graded, 30),
            sample("LUT-graded backdrop just outside the matte edge", 15, (MATTE_SPLIT + 3, 85, MATTE_SPLIT + 13, 95), graded, 30),
            sample("card inside its brush", card_frame, (x + 5, y + 5, x + width - 5, y + height - 5), CARD_COLOR, 20),
            sample("backdrop left of the brush", card_frame, (x - 10, 85, x - 3, 95), graded, 30),
            sample("backdrop right of the brush", card_frame, (x + width + 3, 85, x + width + 10, 95), graded, 30),
            sample("backdrop above the brush", card_frame, (x + 40, y - 10, x + 60, y - 3), graded, 30),
            sample("undimmed before the adjustment layer", before_dim, (5, 5, 30, 30), graded, 30),
            sample("backdrop dimmed by the adjustment layer", after_dim, (5, 5, 30, 30),
                   [channel * DIM_BRIGHTNESS for channel in graded], 25),
            sample("card dimmed by the adjustment layer", after_dim, (x + 5, y + 5, x + width - 5, y + height - 5),
                   [channel * DIM_BRIGHTNESS for channel in CARD_COLOR], 20),
            # 2-3 s: union of two rectangle masks; the effect mask dims only the left one.
            sample("panel in the left rectangle, dimmed by its effect mask", shapes, (60, 60, 100, 120),
                   [channel * EFFECT_BRIGHTNESS for channel in PANEL_COLOR], 20),
            sample("panel in the right rectangle, undimmed", shapes, (220, 60, 260, 120), PANEL_COLOR, 15),
            sample("backdrop between the rectangles", shapes, (145, 60, 175, 120), graded, 30),
            sample("backdrop above the rectangles", shapes, (60, 5, 100, 25), graded, 30),
            # 3-4 s: the badge follows its keyframed position across the stage.
            *[sample(f"badge at its keyframed position, frame {frame}", frame,
                     (round(badge_x(frame)) - 6, 84, round(badge_x(frame)) + 6, 96), BADGE_COLOR, 30)
              for frame in (motion_frame + 3, motion_frame + 12)],
            sample("badge gone from where it was", motion_frame + 12,
                   (round(badge_x(motion_frame + 3)) - 6, 84, round(badge_x(motion_frame + 3)) + 6, 96), graded, 30),
            # The SAM2 matte is white from x=SAM2_SPLIT; grow extends it left.
            sample("subject inside its SAM2 mask", motion_frame + 3, (260, 40, 300, 60), SUBJECT_COLOR, 25),
            sample("subject where only the grown SAM2 mask reaches", motion_frame + 3,
                   (SAM2_SPLIT - 8, 40, SAM2_SPLIT - 2, 50), SUBJECT_COLOR, 25),
            sample("backdrop outside the grown SAM2 mask", motion_frame + 3,
                   (SAM2_SPLIT - 30, 40, SAM2_SPLIT - 20, 50), graded, 30),
            # From 3.5 s an HSL adjustment layer removes all saturation. The grey
            # levels are measured, not derived: desaturation weights channels in
            # the renderer's colour space. What matters is that r = g = b and that
            # both hosts agree.
            sample("backdrop made grey by the HSL layer", grey_frame, (5, 5, 30, 30), [165, 165, 165], 25),
            sample("subject made grey by the HSL layer", grey_frame, (260, 40, 300, 60), [138, 138, 138], 25),
        ],
    )


def main() -> None:
    shutil.rmtree(PROJECT, ignore_errors=True)
    write_mask_grade_project(PROJECT)
    SHARED.mkdir(parents=True, exist_ok=True)
    (SHARED / "mask-grade-expectations.json").write_text(
        json.dumps(mask_grade_expectations(), indent=2) + "\n")
    print(f"wrote {PROJECT.relative_to(REPOSITORY)} and {SHARED.relative_to(REPOSITORY)}")


if __name__ == "__main__":
    main()
