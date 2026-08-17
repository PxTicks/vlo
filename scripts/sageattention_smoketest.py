#!/usr/bin/env python3
"""Verify a freshly installed SageAttention actually runs and stays accurate.

Run this with the selected ComfyUI environment's interpreter. Importing the
package is not enough: Triton/CUDA kernels are compiled and launched lazily, so
the test executes an attention call on every visible GPU and compares it
against PyTorch's scaled-dot-product attention with a fixed seed.
"""

from __future__ import annotations

import sys

# SageAttention quantises Q/K/V, so the comparison against the FP reference is
# deliberately loose; it catches broken kernels, not last-bit differences.
MIN_COSINE = 0.99
MAX_RELATIVE_L1 = 0.05


def main() -> int:
    import torch
    import torch.nn.functional as F

    print(f"torch: {torch.__version__} (CUDA {torch.version.cuda})")

    try:
        import triton
    except Exception as exc:
        print(f"FAIL: Triton import failed: {exc}")
        return 1
    print(f"triton: {triton.__version__}")

    try:
        from sageattention import sageattn
    except Exception as exc:
        print(f"FAIL: SageAttention import failed: {exc}")
        return 1

    if not torch.cuda.is_available():
        print("FAIL: no CUDA device is visible")
        return 1
    torch.manual_seed(0)
    shape = (1, 8, 256, 128)  # HND: batch, heads, sequence, head dim
    for device_index in range(torch.cuda.device_count()):
        device = torch.device("cuda", device_index)
        print(f"gpu {device_index}: {torch.cuda.get_device_name(device_index)}")
        with torch.cuda.device(device):
            q, k, v = (
                torch.randn(shape, dtype=torch.float16, device=device)
                for _ in range(3)
            )

            try:
                out = sageattn(q, k, v, tensor_layout="HND", is_causal=False)
                torch.cuda.synchronize(device)
            except Exception as exc:
                print(
                    f"FAIL: SageAttention kernel launch failed on GPU "
                    f"{device_index}: {exc}"
                )
                return 1

            reference = F.scaled_dot_product_attention(q, k, v, is_causal=False)

            a = out.flatten().float()
            b = reference.flatten().float()
            cosine = F.cosine_similarity(a, b, dim=0).item()
            relative_l1 = ((a - b).abs().sum() / b.abs().sum()).item()
            print(f"cosine similarity vs SDPA: {cosine:.5f}")
            print(f"relative L1 error vs SDPA: {relative_l1:.5f}")

            if cosine < MIN_COSINE or relative_l1 > MAX_RELATIVE_L1:
                print(
                    "FAIL: SageAttention output does not match the reference "
                    f"closely enough on GPU {device_index}"
                )
                return 1

    print("SageAttention smoke test passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
