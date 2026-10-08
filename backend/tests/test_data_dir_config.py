from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[2]


def test_data_dir_moves_user_storage_out_of_the_checkout(tmp_path):
    environment = os.environ.copy()
    for key in ("VLO_EXTENSIONS_ROOT", "VLO_EXTENSION_STATE_DIR", "SAM_AUDIO_MODEL_DIR"):
        environment.pop(key, None)
    environment["VLO_DATA_DIR"] = str(tmp_path / "user data")
    code = '''
import json
import config
import main
from services import runtime_settings, workflow_modes
from services.ai_models.capabilities import profiles
from services.extensions.approval_store import ExtensionApprovalStore
from services.workflow_rules.object_info import OBJECT_INFO_PATH

runtime_settings._write_raw_settings({"workflow_mode": "default"})
approvals = ExtensionApprovalStore(config.EXTENSION_STATE_DIR / "approvals.json")
approvals.approve("fixture.data-dir", "sha256:" + "a" * 64, "1.0.0")
print(json.dumps({
    "projects": str(main.PROJECTS_DIR),
    "settings": str(runtime_settings.SETTINGS_PATH),
    "approvals": str(approvals.state_path),
    "extensions": str(config.EXTENSIONS_ROOT),
    "marker": str(profiles.PROFILE_MARKER_PATH),
    "installerMarker": str(profiles.INSTALLER_MARKER_PATH),
    "workflows": str(workflow_modes.WORKFLOWS_DIR),
    "packagedWorkflows": str(workflow_modes.DEFAULT_WORKFLOWS_DIR),
    "objectInfo": str(OBJECT_INFO_PATH),
    "sam2": str(config.SAM2_SEARCH_PATHS[0]),
    "samAudio": str(config.SAM_AUDIO_MODEL_DIR),
    "extraModelPaths": str(config.EXTRA_MODEL_PATHS_FILE),
}))
'''
    result = subprocess.run(
        [sys.executable, "-c", code], cwd=ROOT / "backend", env=environment,
        capture_output=True, text=True, check=True, timeout=30,
    )
    paths = json.loads(result.stdout)
    data = tmp_path / "user data"
    assert paths["projects"] == str(data / "projects")
    assert paths["marker"] == str(data / "runtime" / "install-profiles.json")
    # The installers do not read VLO_DATA_DIR, so their record stays in the checkout.
    assert paths.pop("installerMarker") == str(ROOT / "backend" / "runtime" / "install-profiles.json")
    assert paths["extensions"] == str(data / "extensions" / "installed")
    for name, value in paths.items():
        if name == "packagedWorkflows":
            # Workflows shipped with the app stay with the app.
            assert Path(value).is_relative_to(ROOT / "backend" / "assets")
        else:
            assert Path(value).is_relative_to(data)
    assert json.loads(Path(paths["settings"]).read_text())["workflow_mode"] == "default"
    assert "fixture.data-dir" in json.loads(Path(paths["approvals"]).read_text())["approvals"]


def test_without_data_dir_the_checkout_layout_is_unchanged():
    environment = os.environ.copy()
    environment["VLO_DATA_DIR"] = ""
    result = subprocess.run(
        [sys.executable, "-c", "import config, json; print(json.dumps([str(config.PROJECTS_ROOT), str(config.RUNTIME_ROOT), str(config.USER_ASSETS_ROOT), str(config.EXTRA_MODEL_PATHS_FILE)]))"],
        cwd=ROOT / "backend", env=environment, capture_output=True, text=True,
        check=True, timeout=10,
    )
    assert json.loads(result.stdout) == [
        str(ROOT / "projects"), str(ROOT / "backend" / "runtime"), str(ROOT / "backend" / "assets"),
        str(ROOT / "extra_model_paths.yaml"),
    ]
