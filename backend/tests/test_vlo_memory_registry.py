import os
import sys


sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from comfyui_custom_nodes.vlo_memory_loader.media_registry import (  # noqa: E402
    MediaRegistry,
    MediaRegistryCapacityError,
    MediaTooLargeError,
)


def test_media_registry_registers_and_marks_access() -> None:
    registry = MediaRegistry(
        max_item_size_bytes=64,
        max_total_size_bytes=128,
        unread_ttl_seconds=3600,
        accessed_ttl_seconds=600,
    )

    item = registry.register(
        kind="video",
        filename="clip.mp4",
        content_type="video/mp4",
        data=b"1234",
    )

    assert registry.total_size_bytes == 4

    peeked = registry.get(item.media_id, mark_accessed=False)
    assert peeked is not None
    assert peeked.accessed_once is False

    accessed = registry.get(item.media_id)
    assert accessed is not None
    assert accessed.accessed_once is True


def test_media_registry_uses_shorter_ttl_after_first_access() -> None:
    registry = MediaRegistry(
        max_item_size_bytes=64,
        max_total_size_bytes=128,
        unread_ttl_seconds=10,
        accessed_ttl_seconds=5,
    )

    now = 100.0
    registry._now = lambda: now  # type: ignore[method-assign]

    unread = registry.register(
        kind="image",
        filename="still.png",
        content_type="image/png",
        data=b"12",
    )
    accessed = registry.register(
        kind="audio",
        filename="tone.wav",
        content_type="audio/wav",
        data=b"34",
    )

    now = 104.0
    assert registry.get(accessed.media_id) is not None

    now = 109.0
    registry.cleanup()
    assert registry.get(unread.media_id, mark_accessed=False) is not None
    assert registry.get(accessed.media_id, mark_accessed=False) is None

    now = 111.0
    registry.cleanup()
    assert registry.get(unread.media_id, mark_accessed=False) is None


def test_media_registry_evicts_oldest_unread_item_first() -> None:
    registry = MediaRegistry(
        max_item_size_bytes=8,
        max_total_size_bytes=10,
        unread_ttl_seconds=3600,
        accessed_ttl_seconds=3600,
    )

    now = 200.0
    registry._now = lambda: now  # type: ignore[method-assign]

    oldest_unread = registry.register(
        kind="video",
        filename="old.mp4",
        content_type="video/mp4",
        data=b"1234",
    )

    now = 201.0
    kept_accessed = registry.register(
        kind="video",
        filename="kept.mp4",
        content_type="video/mp4",
        data=b"5678",
    )
    assert registry.get(kept_accessed.media_id) is not None

    now = 202.0
    newest = registry.register(
        kind="video",
        filename="new.mp4",
        content_type="video/mp4",
        data=b"9012",
    )

    assert registry.get(oldest_unread.media_id, mark_accessed=False) is None
    assert registry.get(kept_accessed.media_id, mark_accessed=False) is not None
    assert registry.get(newest.media_id, mark_accessed=False) is not None


def test_media_registry_rejects_oversized_items_and_full_accessed_cache() -> None:
    registry = MediaRegistry(
        max_item_size_bytes=4,
        max_total_size_bytes=4,
        unread_ttl_seconds=3600,
        accessed_ttl_seconds=3600,
    )

    try:
        registry.register(
            kind="image",
            filename="too-big.png",
            content_type="image/png",
            data=b"12345",
        )
    except MediaTooLargeError:
        pass
    else:
        raise AssertionError("Expected oversized media to be rejected")

    item = registry.register(
        kind="image",
        filename="full.png",
        content_type="image/png",
        data=b"1234",
    )
    assert registry.get(item.media_id) is not None

    try:
        registry.register(
            kind="image",
            filename="overflow.png",
            content_type="image/png",
            data=b"1",
        )
    except MediaRegistryCapacityError:
        pass
    else:
        raise AssertionError("Expected registry capacity failure")
