from __future__ import annotations

import re
from pathlib import Path

import pytest

from services.comfyui import node_pack_versions
from services.comfyui.node_pack_versions import (
    COMFYUI_VLO_MINIMUM_VERSION,
    COMFYUI_VLO_NODE_TYPES,
    check_configured_comfyui_vlo,
    describe_report,
    inspect_comfyui_vlo,
    main,
    parse_release,
)

SHIPPED_WORKFLOW_DIRS = (
    Path(__file__).resolve().parents[1] / "assets" / ".config" / "default_workflows",
    Path(__file__).resolve().parents[1] / "assets" / ".config" / "high_vram_workflows",
)
# Both workflow formats: API prompts name a node's class in "class_type", the
# editor graph (and its subgraph definitions) in "type".
VLO_NODE_TYPE_PATTERN = re.compile(r'"(?:class_)?type"\s*:\s*"(vlo[A-Z]\w*)"')


def write_pack(
    custom_nodes: Path,
    folder: str,
    *,
    version: str | None = COMFYUI_VLO_MINIMUM_VERSION,
    name: str = "comfyui-vlo",
    git: bool = False,
    pyproject: bool = True,
) -> Path:
    pack_dir = custom_nodes / folder
    pack_dir.mkdir(parents=True)
    if pyproject:
        lines = ["[project]", f'name = "{name}"']
        if version is not None:
            lines.append(f'version = "{version}"')
        (pack_dir / "pyproject.toml").write_text("\n".join(lines) + "\n", encoding="utf-8")
    if git:
        (pack_dir / ".git").mkdir()
    return pack_dir


def make_checkout(install_dir: Path) -> Path:
    (install_dir / "custom_nodes").mkdir(parents=True)
    (install_dir / "main.py").write_text("", encoding="utf-8")
    return install_dir


@pytest.fixture
def comfyui_dir(tmp_path: Path) -> Path:
    return make_checkout(tmp_path / "ComfyUI")


@pytest.fixture
def local_comfyui(monkeypatch, comfyui_dir: Path) -> Path:
    monkeypatch.setattr("services.model_registry.is_comfyui_local", lambda: True)
    monkeypatch.setattr(
        "services.runtime_settings.get_comfyui_install_dir", lambda: comfyui_dir
    )
    return comfyui_dir


def test_shipped_workflows_only_use_vlo_nodes_the_minimum_was_set_for():
    used: set[str] = set()
    for workflow_dir in SHIPPED_WORKFLOW_DIRS:
        for path in workflow_dir.rglob("*.json"):
            used.update(VLO_NODE_TYPE_PATTERN.findall(path.read_text(encoding="utf-8")))

    assert used, "expected the shipped workflows to use ComfyUI-vlo nodes"
    unlisted = sorted(used - COMFYUI_VLO_NODE_TYPES)
    assert not unlisted, (
        f"Shipped workflows use ComfyUI-vlo nodes {unlisted} that are not in "
        "COMFYUI_VLO_NODE_TYPES. Add them, and raise COMFYUI_VLO_MINIMUM_VERSION "
        "to the ComfyUI-vlo release that ships them."
    )


@pytest.mark.parametrize(
    ("version", "expected"),
    [
        ("0.3.0", (0, 3)),
        ("0.3", (0, 3)),
        ("1.0.0", (1,)),
        ("v1.2.0rc1", (1, 2)),
        ("0.10.1", (0, 10, 1)),
        ("unknown", None),
        ("", None),
    ],
)
def test_parse_release(version: str, expected: tuple[int, ...] | None):
    assert parse_release(version) == expected


def test_minor_versions_compare_numerically():
    assert parse_release("0.10.0") > parse_release("0.9.0")


@pytest.mark.parametrize("install_dir", [None, Path("/definitely/not/here")])
def test_without_a_local_install_nothing_is_checked(install_dir: Path | None):
    report = inspect_comfyui_vlo(install_dir)

    assert report["status"] == "not_checked"
    assert report["updateCommand"] is None


def test_a_folder_without_comfyui_is_not_checked(tmp_path: Path):
    (tmp_path / "custom_nodes").mkdir()

    assert inspect_comfyui_vlo(tmp_path)["status"] == "not_checked"


def test_a_portable_bundle_resolves_its_nested_checkout(tmp_path: Path):
    # The Windows portable layout: the configured folder holds ComfyUI/.
    checkout = make_checkout(tmp_path / "ComfyUI_windows_portable" / "ComfyUI")
    pack_dir = write_pack(checkout / "custom_nodes", "ComfyUI-vlo", git=True)

    report = inspect_comfyui_vlo(tmp_path / "ComfyUI_windows_portable")

    assert report["status"] == "ok"
    assert report["path"] == str(pack_dir)


def test_a_portable_bundle_clones_into_its_nested_checkout(tmp_path: Path):
    checkout = make_checkout(tmp_path / "ComfyUI_windows_portable" / "ComfyUI")

    report = inspect_comfyui_vlo(tmp_path / "ComfyUI_windows_portable")

    assert report["status"] == "missing"
    assert str(checkout / "custom_nodes" / "ComfyUI-vlo") in report["updateCommand"]


def test_a_missing_pack_reports_the_clone_command(comfyui_dir: Path):
    report = inspect_comfyui_vlo(comfyui_dir)

    assert report["status"] == "missing"
    assert report["path"] is None
    assert report["updateCommand"] == (
        "git clone https://github.com/PxTicks/ComfyUI-vlo "
        f'"{comfyui_dir / "custom_nodes" / "ComfyUI-vlo"}"'
    )


def test_a_current_git_clone_is_ok(comfyui_dir: Path):
    pack_dir = write_pack(comfyui_dir / "custom_nodes", "ComfyUI-vlo", git=True)

    report = inspect_comfyui_vlo(comfyui_dir)

    assert report == {
        "status": "ok",
        "packId": "comfyui-vlo",
        "requiredVersion": COMFYUI_VLO_MINIMUM_VERSION,
        "installedVersion": COMFYUI_VLO_MINIMUM_VERSION,
        "path": str(pack_dir),
        "updateCommand": None,
        "managed": False,
    }


def test_a_registry_install_is_found_by_its_project_name(comfyui_dir: Path):
    # Registry and ComfyUI-Manager installs name the folder after the pack id.
    write_pack(comfyui_dir / "custom_nodes", "comfyui-vlo", version="99.0.0")

    report = inspect_comfyui_vlo(comfyui_dir)

    assert report["status"] == "ok"
    assert report["installedVersion"] == "99.0.0"


def test_an_old_git_clone_reports_a_pull(comfyui_dir: Path):
    pack_dir = write_pack(
        comfyui_dir / "custom_nodes", "ComfyUI-vlo", version="0.1.0", git=True
    )

    report = inspect_comfyui_vlo(comfyui_dir)

    assert report["status"] == "outdated"
    assert report["installedVersion"] == "0.1.0"
    assert report["updateCommand"] == f'git -C "{pack_dir}" pull --ff-only'


def test_an_old_registry_install_has_no_command(comfyui_dir: Path):
    write_pack(comfyui_dir / "custom_nodes", "comfyui-vlo", version="0.1.0")

    report = inspect_comfyui_vlo(comfyui_dir)

    assert report["status"] == "outdated"
    assert report["updateCommand"] is None
    assert "ComfyUI-Manager" in describe_report(report)


def test_a_clone_from_before_packaging_is_unreadable(comfyui_dir: Path):
    write_pack(comfyui_dir / "custom_nodes", "ComfyUI-vlo", pyproject=False, git=True)

    report = inspect_comfyui_vlo(comfyui_dir)

    assert report["status"] == "unreadable"
    assert report["installedVersion"] is None
    assert report["updateCommand"] is not None


def test_another_pack_in_a_vlo_named_folder_is_ignored(comfyui_dir: Path):
    write_pack(comfyui_dir / "custom_nodes", "ComfyUI-vlo", name="something-else")

    assert inspect_comfyui_vlo(comfyui_dir)["status"] == "missing"


@pytest.mark.parametrize(
    "folder", [".disabled/ComfyUI-vlo", "ComfyUI-vlo.disabled"]
)
def test_disabled_copies_do_not_count(comfyui_dir: Path, folder: str):
    write_pack(comfyui_dir / "custom_nodes", folder)

    assert inspect_comfyui_vlo(comfyui_dir)["status"] == "missing"


def test_the_worst_of_several_copies_is_reported(comfyui_dir: Path):
    custom_nodes = comfyui_dir / "custom_nodes"
    write_pack(custom_nodes, "ComfyUI-vlo", git=True)
    stale = write_pack(custom_nodes, "comfyui-vlo-old", version="0.1.0", git=True)

    report = inspect_comfyui_vlo(comfyui_dir)

    assert report["status"] == "outdated"
    assert report["path"] == str(stale)


def test_project_table_scan_without_tomllib(monkeypatch, comfyui_dir: Path):
    pack_dir = comfyui_dir / "custom_nodes" / "ComfyUI-vlo"
    pack_dir.mkdir()
    (pack_dir / "pyproject.toml").write_text(
        "\n".join(
            [
                "[build-system]",
                'name = "not-this-one"',
                "",
                "[project]",
                'name = "comfyui-vlo"',
                "version = '0.2.0'  # pinned",
                "",
                "[tool.comfy]",
                'version = "9.9.9"',
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(node_pack_versions, "tomllib", None)

    report = inspect_comfyui_vlo(comfyui_dir)

    assert report["installedVersion"] == "0.2.0"
    assert report["status"] == "outdated"


def test_cli_reports_and_never_fails(comfyui_dir: Path, capsys):
    write_pack(comfyui_dir / "custom_nodes", "ComfyUI-vlo", version="0.1.0", git=True)

    assert main(["--comfyui-dir", str(comfyui_dir)]) == 0

    output = capsys.readouterr().out
    assert "ComfyUI-vlo 0.1.0" in output
    assert "pull --ff-only" in output
    assert "restart ComfyUI" in output
    assert output.isascii()


def test_cli_reads_the_configured_install(local_comfyui: Path, capsys):
    write_pack(local_comfyui / "custom_nodes", "ComfyUI-vlo")

    assert main([]) == 0

    assert "is up to date" in capsys.readouterr().out


def test_a_remote_comfyui_is_not_judged_by_the_saved_local_install(
    monkeypatch, local_comfyui: Path, capsys
):
    # The directory is still saved after switching to a remote server, but
    # its pack says nothing about the ComfyUI vlo now talks to.
    write_pack(local_comfyui / "custom_nodes", "ComfyUI-vlo", version="0.1.0", git=True)
    monkeypatch.setattr("services.model_registry.is_comfyui_local", lambda: False)

    report = check_configured_comfyui_vlo()

    assert report["status"] == "not_checked"
    assert report["path"] is None
    assert report["updateCommand"] is None
    assert main([]) == 0
    assert "skipped" in capsys.readouterr().out
