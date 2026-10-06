import time
import pytest
from fastapi import HTTPException
from services import local_machine
from services.local_machine import EditorTransport, resolve_path

@pytest.fixture
def roots(tmp_path, monkeypatch):
    configured = {name: tmp_path / name for name in ("projects", "temp", "reference")}
    for folder in configured.values():
        folder.mkdir()
    monkeypatch.setattr(local_machine, "ROOTS", configured)
    return configured

@pytest.mark.parametrize("relative", ["../escape", "C:/escape", "foo\\escape", "/escape", "foo/../../escape"])
def test_path_escape_rejected(roots, relative):
    with pytest.raises(HTTPException):
        resolve_path("projects", relative, write=True)

def test_reference_root_is_read_only_and_normal_projects_allowed(roots):
    assert resolve_path("projects", "Film/assets/image.png", write=True) == roots["projects"] / "Film/assets/image.png"
    with pytest.raises(HTTPException):
        resolve_path("reference", "image.png", write=True)

def test_rubyapp_scene_root_is_readable_but_never_writable(roots):
    # Issue (Rubyapp board #146): takes must import straight from the
    # Rubyapp project folders, read-only.
    configured = {**roots, "rubyapp": roots["projects"].parent / "rubyapp"}
    configured["rubyapp"].mkdir()
    monkey_roots = pytest.MonkeyPatch()
    monkey_roots.setattr(local_machine, "ROOTS", configured)
    try:
        scene = configured["rubyapp"] / "film/06 Scenes/Scene 01/Takes/take.mp4"
        scene.parent.mkdir(parents=True)
        scene.write_bytes(b"x")
        assert resolve_path("rubyapp", "film/06 Scenes/Scene 01/Takes/take.mp4") == scene
        with pytest.raises(HTTPException):
            resolve_path("rubyapp", "film/rewrite.mp4", write=True)
    finally:
        monkey_roots.undo()

def test_native_project_temporary_paths_use_shared_temp_root(roots):
    assert resolve_path("projects", "Film/.vloproject/temporary/iframe-selections/ref.png", write=True) == roots["temp"] / "project_temporary/Film/iframe-selections/ref.png"

def test_symlink_cannot_escape(roots, tmp_path):
    link = roots["projects"] / "escape"
    try:
        link.symlink_to(tmp_path, target_is_directory=True)
    except OSError:
        pytest.skip("Symlink permission unavailable")
    with pytest.raises(HTTPException):
        resolve_path("projects", "escape/file.png", write=True)

def test_offline_commands_refused():
    with pytest.raises(HTTPException) as error:
        EditorTransport().submit("project.create", {"title": "Film"})
    assert error.value.status_code == 503

def test_command_result_is_real_ack_and_single_authority():
    transport = EditorTransport()
    transport.heartbeat("one")
    with pytest.raises(HTTPException):
        transport.heartbeat("two")
    job = transport.submit("project.create", {"title":"Film"})
    assert job["status"] == "pending"
    assert transport.next("one")["status"] == "running"
    with pytest.raises(HTTPException):
        transport.finish("two", job["id"], {}, None)
    assert transport.finish("one", job["id"], {"project":"Film"}, None)["status"] == "succeeded"
    assert transport.jobs[job["id"]]["result"] == {"project":"Film"}

def test_disconnected_commands_never_replayed_by_new_editor():
    transport = EditorTransport()
    transport.heartbeat("one")
    job = transport.submit("generation.start", {})
    transport.next("one")
    transport.seen = time.monotonic() - 16
    transport.heartbeat("two")
    assert transport.next("two") is None
    assert job["status"] == "failed"
    assert "outcome unknown" in job["error"]

def test_native_failure_is_observable():
    transport = EditorTransport()
    transport.heartbeat("one")
    job = transport.submit("export.start", {})
    transport.next("one")
    assert transport.finish("one", job["id"], None, "Native renderer busy")["status"] == "failed"

def test_disabled_workflow_cannot_be_opened_or_disguised(monkeypatch):
    from services import workflow_modes
    monkeypatch.setattr(workflow_modes, "LOCAL_MACHINE_MODE", True)
    assert not workflow_modes.machine_workflow_allowed("vlo_ltx2_5.json")
    assert workflow_modes.machine_workflow_allowed("vlo_minimax_h3_i2v.json")
    assert not workflow_modes.machine_submission_allowed("vlo_ltx2_5.json", {})
    assert not workflow_modes.machine_submission_allowed(None, {})
    assert not workflow_modes.machine_submission_allowed("vlo_minimax_h3_i2v.json", {"1":{"class_type":"LTXVLoader", "inputs":{}}})
    qwen = {"1":{"class_type":"UNETLoader", "inputs":{"unet_name":"qwen_image_2.1_int8_convrot.safetensors"}},"2":{"class_type":"CLIPTextEncode","inputs":{"text":"a wan2 LTX poster"}}}
    assert workflow_modes.machine_submission_allowed("vlo_qwen_image_2_1_edit.json", qwen)
    h3 = {"1":{"class_type":"DiffusionModelLoaderKJ", "inputs":{"model_name":"minimax_h3_ref2va_pruned_fp8_scaled.safetensors"}}}
    assert workflow_modes.machine_submission_allowed("vlo_minimax_h3_i2v.json", h3)
    fake = {"1":{"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":"sdxl.safetensors"}}}
    assert not workflow_modes.machine_submission_allowed("vlo_minimax_h3_fake.json", fake)
    assert not workflow_modes.machine_submission_allowed("vlo_minimax_h3_i2v.json", {**h3,**{"3":fake["1"]}})
    assert not workflow_modes.machine_submission_allowed("vlo_minimax_h3_i2v.json", {"1":{"class_type":"CLIPTextEncode","inputs":{"text":"minimax_h3"}}})
    assert not workflow_modes.machine_submission_allowed("vlo_minimax_h3_i2v.json", qwen)

def test_actual_ruby_enabled_graphs_pass_positive_model_validation(monkeypatch):
    import json
    from pathlib import Path
    from services import workflow_modes
    monkeypatch.setattr(workflow_modes, "LOCAL_MACHINE_MODE", True)
    # Local installed owner presets are read-only evidence; no generation is submitted.
    graph_root = Path(__file__).resolve().parents[3] / "rubyapp-videogenerator/server/presets/workflow_api"
    if not graph_root.exists():
        pytest.skip("Ruby owner presets are not installed on this host")
    h3 = json.loads((graph_root / "MiniMax_H3_Ref_Final_Movie_10step.json").read_text(encoding="utf-8-sig"))
    qwen = json.loads((graph_root / "Qwen_Image_2_1_Edit.json").read_text(encoding="utf-8-sig"))
    assert workflow_modes.machine_submission_allowed("vlo_minimax_h3_ruby_verified.json", h3)
    assert workflow_modes.machine_submission_allowed("vlo_qwen_image_2_1_ruby_verified.json", qwen)

def test_rest_storage_transactions_and_origin_guard(roots, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routers import local_machine as machine_router
    monkeypatch.setattr(machine_router, "ROOTS", roots)
    monkeypatch.setattr(machine_router, "ENABLED", True)
    app = FastAPI()
    app.include_router(machine_router.router)
    app.middleware("http")(machine_router.local_machine_guard)
    with TestClient(app) as client:
        assert client.put("/api/machine/fs/file", params={"root":"reference","path":"image.png"},content=b"x").status_code == 403
        assert client.put("/api/machine/fs/file", params={"root":"projects","path":"../escape"},content=b"x").status_code == 400
        assert client.get("/api/machine/status",headers={"origin":"https://untrusted.example"}).status_code == 403
        assert client.put("/api/machine/fs/file",params={"root":"projects","path":"Film/exports/result.writing"},content=b"first").status_code == 200
        assert client.put("/api/machine/fs/file",params={"root":"projects","path":"Film/exports/result.writing","position":5},content=b" second").status_code == 200
        assert client.post("/api/machine/fs/move",params={"root":"projects","source":"Film/exports/result.writing","destination":"Film/exports/result.mp4"}).status_code == 200
        assert client.get("/api/machine/fs/file",params={"root":"projects","path":"Film/exports/result.mp4"}).content == b"first second"
        assert client.delete("/api/machine/fs/entry",params={"root":"projects","path":"","recursive":True}).status_code == 403
        assert roots["projects"].exists()
