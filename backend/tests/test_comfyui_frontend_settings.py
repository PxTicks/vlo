import json
from pathlib import Path

from services.comfyui import frontend_settings
from services.comfyui.frontend_settings import (
    SETTINGS_RELATIVE_PATH,
    seed_managed_frontend_settings,
)


def _write_install(path: Path, custom_node_name: str = "ComfyUI-VideoHelperSuite") -> None:
    (path / "custom_nodes" / custom_node_name).mkdir(parents=True)


def _read_settings(install_path: Path) -> dict[str, object]:
    return json.loads((install_path / SETTINGS_RELATIVE_PATH).read_text(encoding="utf-8"))


def test_animated_previews_are_seeded_when_no_settings_file_exists(tmp_path: Path) -> None:
    _write_install(tmp_path)

    seeded = seed_managed_frontend_settings(tmp_path)

    assert seeded == ["VHS.LatentPreview"]
    assert _read_settings(tmp_path) == {"VHS.LatentPreview": True}


def test_seeding_preserves_existing_settings(tmp_path: Path) -> None:
    _write_install(tmp_path)
    settings_path = tmp_path / SETTINGS_RELATIVE_PATH
    settings_path.parent.mkdir(parents=True)
    settings_path.write_text(
        json.dumps({"Comfy.TutorialCompleted": True}),
        encoding="utf-8",
    )

    seeded = seed_managed_frontend_settings(tmp_path)

    assert seeded == ["VHS.LatentPreview"]
    assert _read_settings(tmp_path) == {
        "Comfy.TutorialCompleted": True,
        "VHS.LatentPreview": True,
    }


def test_an_explicit_user_choice_is_never_overwritten(tmp_path: Path) -> None:
    _write_install(tmp_path)
    settings_path = tmp_path / SETTINGS_RELATIVE_PATH
    settings_path.parent.mkdir(parents=True)
    settings_path.write_text(json.dumps({"VHS.LatentPreview": False}), encoding="utf-8")

    assert seed_managed_frontend_settings(tmp_path) == []
    assert _read_settings(tmp_path) == {"VHS.LatentPreview": False}


def test_seeding_is_idempotent(tmp_path: Path) -> None:
    _write_install(tmp_path)

    assert seed_managed_frontend_settings(tmp_path) == ["VHS.LatentPreview"]
    assert seed_managed_frontend_settings(tmp_path) == []


def test_manager_installed_node_folder_casing_is_recognized(tmp_path: Path) -> None:
    _write_install(tmp_path, custom_node_name="comfyui-videohelpersuite")

    assert seed_managed_frontend_settings(tmp_path) == ["VHS.LatentPreview"]


def test_checkouts_without_the_node_are_left_alone(tmp_path: Path) -> None:
    _write_install(tmp_path, custom_node_name="ComfyUI-KJNodes")

    assert seed_managed_frontend_settings(tmp_path) == []
    assert not (tmp_path / SETTINGS_RELATIVE_PATH).exists()


def test_non_utf8_settings_are_left_untouched(tmp_path: Path) -> None:
    _write_install(tmp_path)
    settings_path = tmp_path / SETTINGS_RELATIVE_PATH
    settings_path.parent.mkdir(parents=True)
    settings_path.write_bytes(b'{"Comfy.Locale": "\xff\xfe"}')

    assert seed_managed_frontend_settings(tmp_path) == []
    assert settings_path.read_bytes() == b'{"Comfy.Locale": "\xff\xfe"}'


def test_a_failed_write_never_escapes_as_an_error(tmp_path: Path, monkeypatch) -> None:
    _write_install(tmp_path)

    def fail(*args, **kwargs):
        del args, kwargs
        raise OSError("no space left on device")

    monkeypatch.setattr(frontend_settings.os, "replace", fail)
    # Even the cleanup of the temporary file can fail; a launch must survive it.
    monkeypatch.setattr(Path, "unlink", fail)

    assert seed_managed_frontend_settings(tmp_path) == []


def test_malformed_settings_are_left_untouched(tmp_path: Path) -> None:
    _write_install(tmp_path)
    settings_path = tmp_path / SETTINGS_RELATIVE_PATH
    settings_path.parent.mkdir(parents=True)
    settings_path.write_text("{not json", encoding="utf-8")

    assert seed_managed_frontend_settings(tmp_path) == []
    assert settings_path.read_text(encoding="utf-8") == "{not json"
