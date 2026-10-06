import hashlib
import json
from pathlib import Path
import pytest
import httpx
from fastapi import HTTPException
from pydantic import ValidationError
from routers.local_machine import LibraryWorkflow, import_library_workflow
from services import ruby_owner, ruby_import_validation

def test_library_request_cannot_silently_ignore_shot_or_unknown_fields():
    request = LibraryWorkflow(preset_id="future_h3",shot={"extend_from":"E:/Media/VLO/Project/source.mp4","duration_s":5})
    assert request.shot.extend_from.endswith("source.mp4")
    assert request.shot.duration_s == 5
    with pytest.raises(ValidationError):
        LibraryWorkflow(preset_id="future_h3",shot={"duration":5})
    with pytest.raises(ValidationError):
        LibraryWorkflow(preset_id="future_h3",workflow_graph={})

@pytest.mark.anyio
async def test_original_owner_builder_preserves_source_and_head_and_prunes_empty_optional_slots(tmp_path,monkeypatch):
    installed = Path("E:/rubyapp/Library/Preset/multiref_new_av_extension_v4")
    if not installed.exists(): pytest.skip("Original Ruby v4 is not installed")
    directory = tmp_path/"Preset"/installed.name
    directory.mkdir(parents=True)
    for name in ("preset.json","workflow.json"):
        (directory/name).write_bytes((installed/name).read_bytes())
    monkeypatch.setattr(ruby_owner,"LIBRARY_ROOT",tmp_path)
    hashes=[hashlib.sha256((directory/name).read_bytes()).hexdigest() for name in ("preset.json","workflow.json")]
    identity=hashlib.sha256(":".join(hashes).encode()).hexdigest()
    card=ruby_owner.source_card(installed.name,identity)
    clip=tmp_path/"source.mp4";clip.write_bytes(b"test-media-opaque-no-decode")
    monkeypatch.setattr(ruby_owner,"MEDIA_ROOTS",[tmp_path])
    uploads=[]
    async def upload(self,name,data,*,subfolder,kind):
        uploads.append((data,kind,subfolder))
        return {"name":name,"subfolder":subfolder}
    monkeypatch.setattr(ruby_owner.owner_module("comfy").ComfyClient,"upload_image",upload)
    graph=await ruby_owner.build_bound_graph(card,{"source_video":str(clip),"duration_s":5},"native-receipt")
    assert graph["99"]["class_type"]=="VHS_LoadVideo"
    assert graph["99"]["inputs"]["video"].endswith(" [temp]")
    assert graph["101"]["inputs"]["value"]==5
    assert graph["939"]["inputs"]["value"]==39
    assert "1030" not in graph and "317" not in graph
    assert uploads==[(clip.read_bytes(),"temp",uploads[0][2])]
    # An empty VLO media slot contributes no upload/injection. The original
    # native submission processors retain the already bound VHS source.
    from services.gen_pipeline.context import BackendPipelineContext
    from services.gen_pipeline.processors.upload_media import create_upload_media_processor
    from services.gen_pipeline.processors.inject_values import inject_values_processor
    from unittest.mock import AsyncMock
    blocked_io=AsyncMock(side_effect=AssertionError("Empty slots must not upload or register replacements"))
    processor=create_upload_media_processor(blocked_io,blocked_io,blocked_io,{"VHS_LoadVideo":[{"param":"video","input_type":"video"}]})
    expected_source=graph["99"]["inputs"]["video"]
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request:pytest.fail("No native GPU/network submission"))) as client:
        ctx=BackendPipelineContext(client=client,client_id="cpu-proof",workflow=json.loads(json.dumps(graph)),buffered_media={},injections={"101":{"value":5}})
        assert not processor.is_active(ctx)
        await processor.execute(ctx)
        await inject_values_processor.execute(ctx)
    assert ctx.workflow["99"]["inputs"]["video"]==expected_source
    blocked_io.assert_not_awaited()
    with pytest.raises(HTTPException) as rejected:
        ruby_owner.source_card(installed.name,"stale")
    assert rejected.value.status_code==409

def test_media_path_rejects_cross_root_sources_and_remote_uris(tmp_path,monkeypatch):
    monkeypatch.setattr(ruby_owner,"MEDIA_ROOTS",[tmp_path/"media"])
    for path in (str(tmp_path/"outside.mp4"),"filename.mp4","file://remote/E:/Media/source.mp4"):
        with pytest.raises(HTTPException): ruby_owner.media_path(path)

@pytest.mark.anyio
async def test_stale_active_revision_and_inactive_block_new_submission(tmp_path,monkeypatch):
    name="vlo_minimax_h3_ruby_pinned.json";graph={"1":{"class_type":"MiniMaxH3","inputs":{}}}
    (tmp_path/"library_receipts").mkdir();(tmp_path/"workflows").mkdir()
    (tmp_path/"workflows"/name).write_text(json.dumps(graph))
    (tmp_path/"library_receipts"/f"{name}.json").write_text(json.dumps({"preset_id":"owner","source_hash":"hash","source_revision":8,"bound_graph_sha256":ruby_owner.graph_hash(graph)}))
    monkeypatch.setattr(ruby_import_validation,"RUNTIME_ROOT",tmp_path)
    reply={"content_hash":"hash","revision":8};status=200
    transport=httpx.MockTransport(lambda request:httpx.Response(status,json=reply))
    original=httpx.AsyncClient
    monkeypatch.setattr(httpx,"AsyncClient",lambda **kwargs:original(transport=transport,**kwargs))
    assert (await ruby_import_validation.validate_import(name))["current"]
    reply={"content_hash":"newhash","revision":9}
    with pytest.raises(HTTPException) as stale: await ruby_import_validation.validate_import(name)
    assert stale.value.status_code==409
    status=404
    with pytest.raises(HTTPException) as inactive: await ruby_import_validation.validate_import(name)
    assert inactive.value.status_code==409

@pytest.mark.anyio
async def test_extend_import_without_real_source_is_refused_before_receipt_or_upload(monkeypatch):
    entry={"content_hash":"hash","revision":1,"body":{"card":{"bindings":{"extend_from":{"slot":"source_video"}}},"graph":{"1":{"class_type":"UNETLoader","inputs":{"unet_name":"minimax_h3_model.safetensors"}}}}}
    seen=[]
    def reply(request):
        seen.append(request.method)
        return httpx.Response(200,json=entry)
    original=httpx.AsyncClient
    monkeypatch.setattr(httpx,"AsyncClient",lambda **kwargs:original(transport=httpx.MockTransport(reply),**kwargs))
    with pytest.raises(HTTPException) as refused:
        await import_library_workflow(LibraryWorkflow(preset_id="new_extension"))
    assert refused.value.status_code==422
    assert seen==["GET"]

@pytest.mark.anyio
async def test_bound_import_uses_native_preview_and_original_builder_not_raw_qa_template(tmp_path,monkeypatch):
    import config
    installed=Path("E:/rubyapp/Library/Preset/multiref_new_av_extension_v4")
    if not installed.exists(): pytest.skip("Original Ruby v4 is not installed")
    directory=tmp_path/"Preset"/installed.name;directory.mkdir(parents=True)
    for name in ("preset.json","workflow.json"): (directory/name).write_bytes((installed/name).read_bytes())
    monkeypatch.setattr(ruby_owner,"LIBRARY_ROOT",tmp_path)
    hashes=[hashlib.sha256((directory/name).read_bytes()).hexdigest() for name in ("preset.json","workflow.json")]
    identity=hashlib.sha256(":".join(hashes).encode()).hexdigest()
    card=ruby_owner.source_card(installed.name,identity)
    clip=tmp_path/"source.mp4";clip.write_bytes(b"whole-av-source")
    monkeypatch.setattr(ruby_owner,"MEDIA_ROOTS",[tmp_path])
    monkeypatch.setattr(config,"RUNTIME_ROOT",tmp_path/"state")
    native_requests=[]
    async def upload(self,name,data,*,subfolder,kind):
        assert kind=="temp" and data==clip.read_bytes()
        return {"name":name,"subfolder":subfolder}
    monkeypatch.setattr(ruby_owner.owner_module("comfy").ComfyClient,"upload_image",upload)
    entry={"content_hash":identity,"revision":12,"body":{"card":card.as_dict(),"graph":(directory/"workflow.json").read_text(),"sha256":"owner-source-graph"}}
    def reply(request):
        if request.url.path.endswith("/shots/preview"):
            native_requests.append(json.loads(request.content))
            return httpx.Response(200,json={"preset":card.id,"values":{"source_video":str(clip),"duration_s":5},"notes":[{"field":"duration_s","message":"owner native rule"}]})
        if request.url.path.endswith("/library-use/sessions"):
            return httpx.Response(201,json={"library_use_id":"original-consultation"})
        return httpx.Response(200,json=entry)
    original=httpx.AsyncClient
    monkeypatch.setattr(httpx,"AsyncClient",lambda **kwargs:original(transport=httpx.MockTransport(reply),**kwargs))
    result=await import_library_workflow(LibraryWorkflow(preset_id=card.id,shot={"extend_from":str(clip),"duration_s":5,"mode":"extend","extend_kind":"motion","audio_enabled":False},expected_source_hash=identity))
    graph=json.loads((config.RUNTIME_ROOT/"workflows"/result["workflow_id"]).read_text())
    assert graph["101"]["inputs"]["value"]==5
    assert graph["99"]["inputs"]["video"].endswith(" [temp]")
    assert "1030" not in graph
    assert native_requests[0]["preset"]==card.id and native_requests[0]["duration_s"]==5
    assert native_requests[0]["project"]=="vlo"
    assert native_requests[0]["audio_enabled"] is False
    assert graph["103"]["inputs"]["source_audio"]==["1037",0]
    assert graph["946"]["inputs"]["source_audio"]==["1037",0]
    assert result["preview"]["notes"][0]["message"]=="owner native rule"
    assert result["source_revision"]==12 and result["source_hash"]==identity
    manifest=json.loads((config.RUNTIME_ROOT/"library_receipts"/f"{result['workflow_id']}.json").read_text())
    assert manifest["bound_graph_sha256"]==ruby_owner.graph_hash(graph)
    assert manifest["consultation"]["library_use_id"]=="original-consultation"

@pytest.mark.anyio
async def test_blocked_owner_preview_stops_before_receipt_or_media_handoff(tmp_path,monkeypatch):
    import config
    monkeypatch.setattr(config,"RUNTIME_ROOT",tmp_path)
    graph={"1":{"class_type":"UNETLoader","inputs":{"unet_name":"minimax_h3_model.safetensors"}}}
    entry={"content_hash":"owner","revision":1,"body":{"card":{"bindings":{"extend_from":{"slot":"source_video"}}},"graph":graph}}
    note={"field":"audio","severity":"blocked","message":"Original native speech service unavailable"}
    calls=[]
    def reply(request):
        calls.append(request.url.path)
        if request.url.path.endswith("/shots/preview"):
            return httpx.Response(200,json={"preset":"extension","values":{"source_video":"E:/Media/VLO/Project/source.mp4"},"notes":[note]})
        if request.url.path.endswith("/library-use/sessions"):
            return httpx.Response(201,json={"library_use_id":"should-not-open"})
        return httpx.Response(200,json=entry)
    monkeypatch.setattr(ruby_owner,"source_card",lambda *args:object())
    async def build(*args):
        calls.append("media-handoff")
        return graph
    monkeypatch.setattr(ruby_owner,"build_bound_graph",build)
    original=httpx.AsyncClient
    monkeypatch.setattr(httpx,"AsyncClient",lambda **kwargs:original(transport=httpx.MockTransport(reply),**kwargs))
    with pytest.raises(HTTPException) as blocked:
        await import_library_workflow(LibraryWorkflow(preset_id="extension",shot={"extend_from":"E:/Media/VLO/Project/source.mp4"}))
    assert blocked.value.status_code==422
    assert blocked.value.detail["notes"]==[note]
    assert not any("library-use/sessions" in path or path=="media-handoff" for path in calls)

@pytest.mark.anyio
async def test_current_catalogue_without_family_metadata_is_classified_from_actual_graphs(monkeypatch):
    from routers.local_machine import library_enabled_presets
    # Current Ruby entries carry normal detail data, but no model_family.
    rows=[{"owner_id":name,"state":"active","title":"Native owner","summary":"owner description","revision":4,"content_hash":name,"detail":{"kind":"video","engine":"comfyui","number":108}} for name in ("unnamed_new_card","renamed_picture_card","neutral_card")]
    graphs={"unnamed_new_card":{"1":{"class_type":"UNETLoader","inputs":{"unet_name":"minimax_h3_ref2va_pruned_int8_convrot.safetensors"}}},"renamed_picture_card":{"1":{"class_type":"UNETLoader","inputs":{"unet_name":"qwen_image_2.1_int8_convrot.safetensors"}}},"neutral_card":{"1":{"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":"sdxl.safetensors"}}}}
    def reply(request):
        if request.url.path.endswith("/library"):
            assert request.url.params.get("kind")=="preset"
            return httpx.Response(200,json={"entries":rows,"policy_revision":9})
        name=request.url.path.rsplit("/",1)[1]
        row=next(row for row in rows if row["owner_id"]==name)
        return httpx.Response(200,json={**row,"body":{"graph":json.dumps(graphs[name])},"edits":["must not dump history"]})
    original=httpx.AsyncClient
    monkeypatch.setattr(httpx,"AsyncClient",lambda **kwargs:original(transport=httpx.MockTransport(reply),**kwargs))
    result=await library_enabled_presets()
    assert result["enabled_count"]==2
    assert [row["owner_id"] for row in result["entries"]]==["unnamed_new_card","renamed_picture_card"]
    assert result["entries"][0]["detail"]["machine_family"]=="minimax_h3"
    assert all("body" not in row and "edits" not in row for row in result["entries"])
