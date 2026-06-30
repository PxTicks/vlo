from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from services.extensions import (
    BackendJobCapacityError,
    BackendJobDefinition,
    BackendJobManager,
    BackendJobNotFoundError,
    BackendJobNotReadyError,
    BackendJobReadiness,
    BackendJobValidationError,
    ExtensionJobArtifactNotFoundError,
    ExtensionJobArtifactStore,
    ExtensionJobArtifactTooLargeError,
)


async def _wait_for_terminal(
    manager: BackendJobManager,
    extension_id: str,
    job_id: str,
):
    for _attempt in range(200):
        snapshot = manager.get(extension_id, job_id)
        if snapshot.status in ("succeeded", "failed", "cancelled"):
            return snapshot
        await asyncio.sleep(0.005)
    raise AssertionError("job did not reach a terminal state")


def test_artifacts_are_scoped_integrity_checked_and_size_limited(
    tmp_path: Path,
) -> None:
    store = ExtensionJobArtifactStore(
        tmp_path / "artifacts",
        max_artifact_bytes=8,
    )
    record = store.create_input(
        "example.jobs",
        b"source",
        filename="clip.bin",
        content_type="application/octet-stream",
    )
    store.claim_inputs("example.jobs", "job-1", (record.artifact_id,))

    assert store.read_for_job("example.jobs", "job-1", record.artifact_id) == b"source"
    with pytest.raises(ExtensionJobArtifactNotFoundError):
        store.read_for_job("other.jobs", "job-1", record.artifact_id)
    with pytest.raises(ExtensionJobArtifactTooLargeError):
        store.create_input(
            "example.jobs",
            b"too-large",
            filename="large.bin",
            content_type="application/octet-stream",
        )


def test_unclaimed_input_capacity_is_bounded(tmp_path: Path) -> None:
    manager = BackendJobManager(
        ExtensionJobArtifactStore(tmp_path / "artifacts"),
        max_unclaimed_artifacts_per_extension=1,
    )
    manager.register_extension(
        "example.capacity",
        "1.0.0",
        (BackendJobDefinition(id="work", label="Work", run=lambda _c, _v: {}),),
    )
    manager.upload_input(
        "example.capacity",
        b"one",
        filename="one.bin",
        content_type="application/octet-stream",
    )
    with pytest.raises(BackendJobCapacityError, match="unclaimed artifact limit"):
        manager.upload_input(
            "example.capacity",
            b"two",
            filename="two.bin",
            content_type="application/octet-stream",
        )
    asyncio.run(manager.shutdown_all())


def test_standard_job_reports_progress_validates_and_delivers_artifacts(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        store = ExtensionJobArtifactStore(tmp_path / "artifacts")
        manager = BackendJobManager(store)

        def validate_input(value: object) -> object:
            if not isinstance(value, dict) or not isinstance(value.get("scale"), int):
                raise ValueError("scale must be an integer")
            return {"scale": value["scale"]}

        def run(context, value: object) -> object:
            assert isinstance(value, dict)
            source = context.artifacts.read(context.artifacts.input_ids[0])
            context.report_diagnostic(
                "info",
                "Source decoded",
                {"bytes": len(source)},
            )
            context.report_progress(0.5, "Half way")
            output = source * value["scale"]
            artifact = context.artifacts.create(
                output,
                filename="result.bin",
                content_type="application/octet-stream",
            )
            return {"schemaVersion": 1, "artifactId": artifact.artifact_id}

        def validate_result(value: object) -> object:
            if not isinstance(value, dict) or value.get("schemaVersion") != 1:
                raise ValueError("unexpected result")
            return value

        manager.register_extension(
            "example.jobs",
            "1.2.3",
            (
                BackendJobDefinition(
                    id="multiply",
                    label="Multiply bytes",
                    run=run,
                    validate_input=validate_input,
                    validate_result=validate_result,
                    readiness=lambda: BackendJobReadiness.available("Model loaded"),
                ),
            ),
        )
        uploaded = manager.upload_input(
            "example.jobs",
            b"ab",
            filename="source.bin",
            content_type="application/octet-stream",
        )
        submitted = await manager.submit(
            "example.jobs",
            "multiply",
            {"scale": 3},
            (uploaded.artifact_id,),
        )
        completed = await _wait_for_terminal(
            manager,
            "example.jobs",
            submitted.identity.job_id,
        )

        assert completed.status == "succeeded"
        assert completed.progress == 1.0
        assert completed.result is not None
        assert completed.result["schemaVersion"] == 1
        assert len(completed.artifacts) == 1
        assert completed.diagnostics[0].to_dict() == {
            "level": "info",
            "message": "Source decoded",
            "timestamp": completed.diagnostics[0].timestamp,
            "detail": {"bytes": 2},
        }
        record, content = manager.get_artifact(
            "example.jobs",
            completed.artifacts[0].artifact_id,
        )
        assert record.filename == "result.bin"
        assert content == b"ababab"
        assert (await manager.list_job_types("example.jobs"))[0]["readiness"] == {
            "ready": True,
            "message": "Model loaded",
        }

        await manager.shutdown_all()
        assert not (store.root / "example.jobs").exists()

    asyncio.run(scenario())


def test_job_timeout_is_terminal_and_requests_cooperative_stop(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        manager = BackendJobManager(
            ExtensionJobArtifactStore(tmp_path / "artifacts")
        )

        async def run(context, _value: object) -> object:
            while True:
                context.raise_if_cancelled()
                await asyncio.sleep(0.01)

        manager.register_extension(
            "example.timeout",
            "1.0.0",
            (
                BackendJobDefinition(
                    id="slow",
                    label="Slow",
                    run=run,
                    timeout_seconds=0.03,
                ),
            ),
        )
        submitted = await manager.submit("example.timeout", "slow", {})
        completed = await _wait_for_terminal(
            manager,
            "example.timeout",
            submitted.identity.job_id,
        )

        assert completed.status == "failed"
        assert completed.message == "Timed out"
        assert "0.03 second timeout" in (completed.error or "")
        assert (await manager.list_job_types("example.timeout"))[0][
            "timeoutSeconds"
        ] == 0.03
        await manager.shutdown_all()

    asyncio.run(scenario())


def test_job_cancellation_is_cooperative_and_terminal(tmp_path: Path) -> None:
    async def scenario() -> None:
        manager = BackendJobManager(
            ExtensionJobArtifactStore(tmp_path / "artifacts")
        )
        started = asyncio.Event()

        async def run(context, _value: object) -> object:
            started.set()
            while True:
                context.raise_if_cancelled()
                await asyncio.sleep(0.01)

        manager.register_extension(
            "example.cancel",
            "1.0.0",
            (BackendJobDefinition(id="wait", label="Wait", run=run),),
        )
        submitted = await manager.submit("example.cancel", "wait", None)
        await started.wait()
        cancelled = await manager.cancel(
            "example.cancel",
            submitted.identity.job_id,
        )

        assert cancelled.status == "cancelled"
        assert cancelled.cancel_requested is True
        assert cancelled.progress == 1.0
        await manager.shutdown_all()

    asyncio.run(scenario())


def test_queued_job_can_be_cancelled_before_runner_starts(tmp_path: Path) -> None:
    async def scenario() -> None:
        manager = BackendJobManager(
            ExtensionJobArtifactStore(tmp_path / "artifacts")
        )
        manager.register_extension(
            "example.queued-cancel",
            "1.0.0",
            (BackendJobDefinition(id="wait", label="Wait", run=lambda _c, _v: {}),),
        )
        submitted = await manager.submit("example.queued-cancel", "wait", {})
        cancelled = await manager.cancel(
            "example.queued-cancel",
            submitted.identity.job_id,
        )

        assert cancelled.status == "cancelled"
        assert cancelled.cancel_requested is True
        await manager.shutdown_all()

    asyncio.run(scenario())


def test_readiness_and_result_validation_fail_closed(tmp_path: Path) -> None:
    async def scenario() -> None:
        manager = BackendJobManager(
            ExtensionJobArtifactStore(tmp_path / "artifacts")
        )
        manager.register_extension(
            "example.models",
            "1.0.0",
            (
                BackendJobDefinition(
                    id="not-ready",
                    label="Not ready",
                    run=lambda _context, _value: {},
                    readiness=lambda: BackendJobReadiness.unavailable(
                        "Model weights are missing",
                        details={"model": "tracker"},
                    ),
                ),
                BackendJobDefinition(
                    id="bad-result",
                    label="Bad result",
                    run=lambda _context, _value: {"wrong": True},
                    validate_result=lambda _value: (_ for _ in ()).throw(
                        ValueError("result schema mismatch")
                    ),
                ),
            ),
        )

        with pytest.raises(BackendJobNotReadyError, match="weights are missing"):
            await manager.submit("example.models", "not-ready", {})
        submitted = await manager.submit("example.models", "bad-result", {})
        completed = await _wait_for_terminal(
            manager,
            "example.models",
            submitted.identity.job_id,
        )
        assert completed.status == "failed"
        assert "result schema mismatch" in (completed.error or "")

        with pytest.raises(BackendJobValidationError, match="finite JSON"):
            await manager.submit("example.models", "bad-result", {"bad": float("nan")})
        await manager.shutdown_all()

    asyncio.run(scenario())


def test_finished_jobs_and_unclaimed_uploads_expire(tmp_path: Path) -> None:
    async def scenario() -> None:
        clock = [100.0]
        store = ExtensionJobArtifactStore(
            tmp_path / "artifacts",
            now=lambda: clock[0],
        )
        manager = BackendJobManager(
            store,
            finished_ttl_seconds=10,
            unclaimed_artifact_ttl_seconds=10,
            now=lambda: clock[0],
        )
        manager.register_extension(
            "example.expiry",
            "1.0.0",
            (
                BackendJobDefinition(
                    id="finish",
                    label="Finish",
                    run=lambda _context, _value: {"ok": True},
                ),
            ),
        )
        unclaimed = manager.upload_input(
            "example.expiry",
            b"unused",
            filename="unused.bin",
            content_type="application/octet-stream",
        )
        submitted = await manager.submit("example.expiry", "finish", {})
        await _wait_for_terminal(
            manager,
            "example.expiry",
            submitted.identity.job_id,
        )

        clock[0] = 111.0
        with pytest.raises(BackendJobNotFoundError, match="was not found"):
            manager.get("example.expiry", submitted.identity.job_id)
        with pytest.raises(ExtensionJobArtifactNotFoundError):
            store.get_for_delivery("example.expiry", unclaimed.artifact_id)
        await manager.shutdown_all()

    asyncio.run(scenario())
