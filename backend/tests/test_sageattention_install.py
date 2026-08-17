import importlib.util
import sys
from pathlib import Path
from types import ModuleType


def _load_script(name: str) -> ModuleType:
    path = Path(__file__).parents[2] / "scripts" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


install_sageattention = _load_script("install_sageattention")
sageattention_preflight = _load_script("sageattention_preflight")


def test_cuda_toolkit_must_match_torch_cuda_major() -> None:
    assert sageattention_preflight.cuda_versions_are_compatible((13, 0), "13.0")
    assert sageattention_preflight.cuda_versions_are_compatible((13, 1), "13.0")
    assert not sageattention_preflight.cuda_versions_are_compatible((12, 8), "13.0")
    assert not sageattention_preflight.cuda_versions_are_compatible((12, 8), None)


def test_existing_triton_must_match_the_torch_line() -> None:
    assert sageattention_preflight.expected_triton_line("2.12.0+cu130") == "3.7"
    assert sageattention_preflight.triton_matches_line("3.7.1", "3.7")
    assert not sageattention_preflight.triton_matches_line("3.6.0", "3.7")


def test_protocol_parser_preserves_repeated_gpu_entries() -> None:
    parsed = install_sageattention.parse_protocol(
        "GPU=A100 (compute capability 8.0)\n"
        "GPU=RTX 4090 (compute capability 8.9)\n"
        "ARCH_LIST=8.0;8.9\n"
    )

    assert parsed["GPU"] == [
        "A100 (compute capability 8.0)",
        "RTX 4090 (compute capability 8.9)",
    ]
    assert parsed["ARCH_LIST"] == ["8.0;8.9"]


def test_target_python_path_does_not_dereference_a_venv_symlink(
    tmp_path: Path,
) -> None:
    base_python = tmp_path / "base-python"
    base_python.write_text("", encoding="utf-8")
    venv_python = tmp_path / "venv" / "bin" / "python"
    venv_python.parent.mkdir(parents=True)
    venv_python.symlink_to(base_python)

    assert install_sageattention.target_python_path(str(venv_python)) == venv_python


def test_mismatched_existing_checkout_is_left_unchanged(
    tmp_path: Path,
    monkeypatch,
) -> None:
    source = tmp_path / "source"
    (source / ".git").mkdir(parents=True)
    marker = source / "local-change.txt"
    marker.write_text("keep me", encoding="utf-8")

    monkeypatch.setattr(
        install_sageattention,
        "run",
        lambda *_args, **_kwargs: install_sageattention.subprocess.CompletedProcess(
            [], 0, stdout="different-commit\n", stderr=""
        ),
    )

    assert install_sageattention.clone_verified_source(source) is False
    assert marker.read_text(encoding="utf-8") == "keep me"
