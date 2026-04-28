from io import BytesIO
import os
import sys

import av
import numpy as np

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services.sam2.sam2_encoding import encode_binary_masks_to_red_mp4


def _decode_first_frame(video_bytes: bytes) -> tuple[str, np.ndarray]:
    container = av.open(BytesIO(video_bytes), mode="r")
    try:
        stream = container.streams.video[0]
        frame = next(container.decode(video=0))
        return (stream.codec_context.pix_fmt or "", frame.to_ndarray(format="rgb24"))
    finally:
        container.close()


def test_encode_binary_masks_to_red_mp4_uses_non_alpha_video() -> None:
    frames = np.zeros((1, 16, 16), dtype=np.uint8)
    frames[0, 4:12, 4:12] = 255

    encoded = encode_binary_masks_to_red_mp4(frames, 24.0)
    pix_fmt, decoded = _decode_first_frame(encoded)

    assert "a" not in pix_fmt
    assert np.all(decoded[4:12, 4:12, 0] > 32)
    assert np.all(decoded[:4, :, 0] <= 32)


def test_encode_binary_masks_to_red_mp4_preserves_binary_coverage_in_red() -> None:
    frames = np.zeros((1, 16, 16), dtype=np.uint8)
    frames[0, 2:14, 6:10] = 1

    encoded = encode_binary_masks_to_red_mp4(frames, 12.0)
    _, decoded = _decode_first_frame(encoded)
    recovered_mask = decoded[:, :, 0] > 32

    expected_mask = np.zeros((16, 16), dtype=bool)
    expected_mask[2:14, 6:10] = True

    assert np.array_equal(recovered_mask, expected_mask)
