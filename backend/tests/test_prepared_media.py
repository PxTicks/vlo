import time

import pytest

from services.gen_pipeline import prepared_media
from services.gen_pipeline.prepared_media import (
    is_valid_group_id,
    load_prepared_media,
    store_prepared_media,
    sweep_prepared_media,
)


@pytest.fixture(autouse=True)
def isolated_store(tmp_path, monkeypatch):
    monkeypatch.setattr(prepared_media, "PREPARED_MEDIA_ROOT", tmp_path / "prepared")
    (tmp_path / "prepared").mkdir()


def make_buffered_media(payload: bytes = b"video-bytes") -> dict[str, dict[str, object]]:
    return {
        "20:file": {
            "node_id": "20",
            "param": "file",
            "input_type": "video",
            "class_type": "LoadVideo",
            "bytes": payload,
            "content_type": "video/mp4",
            "filename": "prepared.mp4",
            "batch_index": 2,
            "item_options": {"include_audio": True},
        }
    }


def test_a_restored_group_is_indistinguishable_from_the_parsed_form():
    """The whole design rests on this: downstream phases must not be able to
    tell whether the bytes arrived over the wire or came back from the store."""

    buffered = make_buffered_media()
    assert store_prepared_media("group-abc123", buffered) is True

    restored = load_prepared_media("group-abc123")
    assert restored == buffered


def test_storing_a_group_twice_replaces_it_rather_than_merging():
    store_prepared_media("group-abc123", make_buffered_media(b"first"))
    store_prepared_media("group-abc123", make_buffered_media(b"second"))

    restored = load_prepared_media("group-abc123")
    assert restored is not None
    assert restored["20:file"]["bytes"] == b"second"


def test_an_expired_group_is_a_miss_not_a_stale_hit():
    """An expired group must never generate from bytes the caller has moved on
    from; the caller's answer to a miss is simply to resend."""

    store_prepared_media("group-abc123", make_buffered_media())
    later = time.time() + prepared_media.PREPARED_MEDIA_TTL_SECONDS + 1
    assert load_prepared_media("group-abc123") is not None

    original_time = prepared_media.time.time
    try:
        prepared_media.time.time = lambda: later  # type: ignore[assignment]
        assert load_prepared_media("group-abc123") is None
    finally:
        prepared_media.time.time = original_time  # type: ignore[assignment]


def test_a_missing_payload_file_fails_the_whole_group():
    """Partial restoration would silently generate from the wrong inputs, which
    is worse than paying for a re-upload."""

    buffered = make_buffered_media()
    buffered["21:file"] = {**buffered["20:file"], "node_id": "21"}
    store_prepared_media("group-abc123", buffered)

    group_root = prepared_media.PREPARED_MEDIA_ROOT / "group-abc123"
    next(group_root.glob("*.bin")).unlink()

    assert load_prepared_media("group-abc123") is None


def group_dirs() -> list[str]:
    return sorted(
        entry.name
        for entry in prepared_media.PREPARED_MEDIA_ROOT.iterdir()
        if entry.is_dir()
    )


def test_the_oldest_groups_are_evicted_past_the_cap():
    for index in range(prepared_media.PREPARED_MEDIA_MAX_GROUPS + 2):
        # Distinct timestamps, since eviction orders by store time.
        store_prepared_media(f"group-{index:08d}", make_buffered_media())
        time.sleep(0.01)

    # The cap counts the group just written. Sweeping before the insert instead
    # trims to the cap and then adds one, leaving the cap plus one on disk.
    assert len(group_dirs()) == prepared_media.PREPARED_MEDIA_MAX_GROUPS
    assert load_prepared_media("group-00000000") is None
    assert (
        load_prepared_media(
            f"group-{prepared_media.PREPARED_MEDIA_MAX_GROUPS + 1:08d}"
        )
        is not None
    )


def test_an_abandoned_group_is_retired_by_a_later_lookup():
    """A batch that is queued and never repeated does no further store, so
    without a sweep on the read path its bytes would outlive the TTL forever."""

    store_prepared_media("group-abandoned", make_buffered_media())
    store_prepared_media("group-current", make_buffered_media())

    original_time = prepared_media.time.time
    later = original_time() + prepared_media.PREPARED_MEDIA_TTL_SECONDS + 1
    try:
        prepared_media.time.time = lambda: later  # type: ignore[assignment]
        load_prepared_media("group-current")
    finally:
        prepared_media.time.time = original_time  # type: ignore[assignment]

    assert group_dirs() == []


def test_a_startup_sweep_retires_groups_left_by_a_stopped_backend():
    store_prepared_media("group-abandoned", make_buffered_media())

    original_time = prepared_media.time.time
    later = original_time() + prepared_media.PREPARED_MEDIA_TTL_SECONDS + 1
    try:
        prepared_media.time.time = lambda: later  # type: ignore[assignment]
        sweep_prepared_media()
    finally:
        prepared_media.time.time = original_time  # type: ignore[assignment]

    assert group_dirs() == []


def test_a_sweep_leaves_groups_that_are_still_within_the_ttl():
    store_prepared_media("group-abc123", make_buffered_media())
    sweep_prepared_media()

    assert load_prepared_media("group-abc123") is not None


def test_an_empty_group_is_never_stored():
    """Nothing to reuse means nothing to promise the frontend."""

    assert store_prepared_media("group-abc123", {}) is False
    assert load_prepared_media("group-abc123") is None


@pytest.mark.parametrize(
    "group_id",
    [
        "../escape",
        "group/../../etc",
        "short",
        "with space",
        "g" * 65,
        "",
        None,
        123,
    ],
)
def test_group_ids_that_are_not_safe_path_components_are_rejected(group_id):
    """The id comes from the client, so it is constrained rather than trusted."""

    assert is_valid_group_id(group_id) is False
    assert load_prepared_media(group_id) is None  # type: ignore[arg-type]
    assert store_prepared_media(group_id, make_buffered_media()) is False  # type: ignore[arg-type]


def test_a_valid_group_id_accepts_the_frontend_uuid_shape():
    assert is_valid_group_id("3f2504e0-4f89-11d3-9a0c-0305e82c3301") is True
