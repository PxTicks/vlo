"""Synthetic tracking job used to prove the trusted Phase 7 contracts compose."""

from __future__ import annotations

import hashlib
import json
import math
import time

from services.extensions import (
    BackendExtensionContext,
    BackendExtensionDefinition,
    BackendJobDefinition,
    BackendJobReadiness,
)


def _positive_number(value: object, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} must be a number")
    normalized = float(value)
    if not math.isfinite(normalized) or normalized <= 0:
        raise ValueError(f"{label} must be positive and finite")
    return normalized


def _non_negative_number(value: object, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} must be a number")
    normalized = float(value)
    if not math.isfinite(normalized) or normalized < 0:
        raise ValueError(f"{label} must be non-negative and finite")
    return normalized


def _validate_input(value: object) -> object:
    if not isinstance(value, dict) or value.get("schemaVersion") != 1:
        raise ValueError("tracking input must use schemaVersion 1")
    source = value.get("source")
    target = value.get("target")
    if not isinstance(source, dict) or not isinstance(target, dict):
        raise ValueError("tracking input requires source and target objects")
    sample_count = value.get("sampleCount")
    if (
        isinstance(sample_count, bool)
        or not isinstance(sample_count, int)
        or sample_count < 2
        or sample_count > 240
    ):
        raise ValueError("sampleCount must be an integer between 2 and 240")
    target_id = target.get("id")
    if not isinstance(target_id, str) or not target_id.strip():
        raise ValueError("target.id must be non-empty")
    normalized = {
        "schemaVersion": 1,
        "sampleCount": sample_count,
        "source": {
            "width": round(_positive_number(source.get("width"), "source.width")),
            "height": round(
                _positive_number(source.get("height"), "source.height")
            ),
            "fps": _positive_number(source.get("fps"), "source.fps"),
            "startTicks": round(
                _non_negative_number(source.get("startTicks"), "source.startTicks")
            ),
            "endTicks": round(
                _positive_number(source.get("endTicks"), "source.endTicks")
            ),
            "ticksPerSecond": round(
                _positive_number(
                    source.get("ticksPerSecond"),
                    "source.ticksPerSecond",
                )
            ),
        },
        "target": {"id": target_id.strip(), "label": str(target.get("label", "Target"))},
    }
    normalized_source = normalized["source"]
    assert isinstance(normalized_source, dict)
    if normalized_source["endTicks"] <= normalized_source["startTicks"]:
        raise ValueError("source.endTicks must be greater than source.startTicks")
    return normalized


def _validate_result(value: object) -> object:
    if not isinstance(value, dict) or value.get("schemaVersion") != 1:
        raise ValueError("tracking result must use schemaVersion 1")
    if value.get("coordinateSpace") != "source-pixels":
        raise ValueError("tracking result coordinate space is invalid")
    timebase = value.get("timebase")
    dimensions = value.get("sourceDimensions")
    source_window = value.get("sourceWindow")
    samples = value.get("samples")
    target = value.get("target")
    if (
        not isinstance(timebase, dict)
        or timebase.get("kind") != "frames"
        or not isinstance(dimensions, dict)
        or not isinstance(source_window, dict)
        or not isinstance(samples, list)
        or len(samples) < 2
        or not isinstance(target, dict)
    ):
        raise ValueError("tracking result structure is invalid")
    start_ticks = source_window.get("startTicks")
    end_ticks = source_window.get("endTicks")
    if (
        isinstance(start_ticks, bool)
        or not isinstance(start_ticks, int)
        or start_ticks < 0
        or isinstance(end_ticks, bool)
        or not isinstance(end_ticks, int)
        or end_ticks <= start_ticks
    ):
        raise ValueError("tracking result source window is invalid")
    for sample in samples:
        if not isinstance(sample, dict):
            raise ValueError("tracking samples must be objects")
        frame_index = sample.get("frameIndex")
        if isinstance(frame_index, bool) or not isinstance(frame_index, int):
            raise ValueError("tracking frame indices must be integers")
        for field in ("x", "y", "confidence"):
            field_value = sample.get(field)
            if (
                isinstance(field_value, bool)
                or not isinstance(field_value, (int, float))
                or not math.isfinite(float(field_value))
            ):
                raise ValueError(f"tracking sample {field} must be finite")
    return value


def _readiness() -> BackendJobReadiness:
    return BackendJobReadiness(
        ready=True,
        message="Synthetic fixture tracker is ready",
        details={
            "model": "fixture-motion-v1",
            "device": "cpu",
            "purpose": "extension conformance",
        },
    )


def _run_tracking(context, value: object) -> object:
    assert isinstance(value, dict)
    source = value["source"]
    target = value["target"]
    assert isinstance(source, dict)
    assert isinstance(target, dict)
    input_ids = context.artifacts.input_ids
    if len(input_ids) != 1:
        raise ValueError("tracking requires exactly one uploaded source artifact")
    source_bytes = context.artifacts.read(input_ids[0])
    source_digest = hashlib.sha256(source_bytes).hexdigest()
    context.report_diagnostic(
        "info",
        "Source artifact accepted",
        {"bytes": len(source_bytes), "sha256": source_digest},
    )

    width = int(source["width"])
    height = int(source["height"])
    fps = float(source["fps"])
    start_ticks = int(source["startTicks"])
    end_ticks = int(source["endTicks"])
    ticks_per_second = int(source["ticksPerSecond"])
    sample_count = int(value["sampleCount"])
    first_frame = max(0, round((start_ticks / ticks_per_second) * fps))
    last_frame = max(
        first_frame + 1,
        round((end_ticks / ticks_per_second) * fps),
    )
    phase = int(source_digest[:4], 16) / 0xFFFF * math.pi
    samples: list[dict[str, object]] = []
    for index in range(sample_count):
        context.raise_if_cancelled()
        progress = index / (sample_count - 1)
        frame_index = round(first_frame + (last_frame - first_frame) * progress)
        samples.append(
            {
                "frameIndex": frame_index,
                "x": width * (0.2 + 0.6 * progress),
                "y": height * (0.5 + 0.18 * math.sin(progress * math.tau + phase)),
                "confidence": round(0.98 - 0.08 * abs(0.5 - progress), 4),
            }
        )
        context.report_progress(
            (index + 1) / sample_count,
            f"Tracked frame {frame_index}",
        )
        time.sleep(0.005)

    result: dict[str, object] = {
        "schemaVersion": 1,
        "coordinateSpace": "source-pixels",
        "sourceDimensions": {"width": width, "height": height},
        "timebase": {"kind": "frames", "fps": fps},
        "sourceWindow": {"startTicks": start_ticks, "endTicks": end_ticks},
        "target": target,
        "samples": samples,
    }
    artifact = context.artifacts.create(
        json.dumps(result, separators=(",", ":")).encode("utf-8"),
        filename="tracking-result.json",
        content_type="application/json",
    )
    result["artifactId"] = artifact.artifact_id
    return result


def create_extension(
    context: BackendExtensionContext,
) -> BackendExtensionDefinition:
    context.logger.info("Tracking conformance backend activated.")
    return BackendExtensionDefinition(
        jobs=(
            BackendJobDefinition(
                id="track",
                label="Track fixture target",
                run=_run_tracking,
                validate_input=_validate_input,
                validate_result=_validate_result,
                readiness=_readiness,
                timeout_seconds=30,
            ),
        )
    )
