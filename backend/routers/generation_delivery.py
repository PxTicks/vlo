from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, WebSocket
from fastapi.responses import FileResponse

from services.generation_delivery import generation_holding_service

router = APIRouter(prefix="/app/generation-delivery", tags=["generation-delivery"])


@router.get("/projects/{project_id}/pending")
async def list_pending_generation_deliveries(project_id: str):
    return {
        "project_id": project_id,
        "deliveries": await generation_holding_service.list_project_deliveries(project_id),
    }


@router.post("/projects/{project_id}/adopt")
async def adopt_iframe_generation(project_id: str, request: Request):
    """Adopt a generation the user submitted inside the ComfyUI editor iframe.

    The parent frontend supplies the project (attribution ComfyUI can't know)
    and the prompt id observed by the bridge; the backend creates a delivery
    with a backstop-only monitor so the outputs import like any other.
    """
    body = await request.json()
    prompt_id = body.get("prompt_id") if isinstance(body, dict) else None
    if not isinstance(prompt_id, str) or not prompt_id.strip():
        raise HTTPException(status_code=400, detail="prompt_id is required")
    client_id = body.get("client_id")
    workflow_name = body.get("workflow_name")
    generation_metadata = body.get("generation_metadata")
    delivery = await generation_holding_service.adopt_delivery(
        project_id=project_id,
        prompt_id=prompt_id.strip(),
        client_id=client_id if isinstance(client_id, str) and client_id else None,
        workflow_name=workflow_name if isinstance(workflow_name, str) else None,
        generation_metadata=(
            generation_metadata if isinstance(generation_metadata, dict) else None
        ),
    )
    return {"delivery": delivery}


@router.post("/projects/{project_id}/adopt/{prompt_id}/progress")
async def report_adopted_generation_progress(
    project_id: str,
    prompt_id: str,
    request: Request,
):
    body = await request.json()
    if not isinstance(body, dict):
        body = {}
    raw_progress = body.get("progress")
    progress = (
        max(0, min(100, int(raw_progress)))
        if isinstance(raw_progress, (int, float))
        else None
    )
    node = body.get("node")
    updated = await generation_holding_service.mark_running_for_prompt(
        project_id,
        prompt_id,
        progress=progress,
        current_node=node if isinstance(node, str) else None,
    )
    if not updated:
        raise HTTPException(
            status_code=404,
            detail="No active adopted delivery for prompt",
        )
    return {"ok": True}


@router.get("/projects/{project_id}/deliveries/{delivery_id}")
async def get_generation_delivery(project_id: str, delivery_id: str):
    delivery = await generation_holding_service.get_delivery(project_id, delivery_id)
    if delivery is None:
        raise HTTPException(status_code=404, detail="Delivery not found")
    return delivery


@router.get("/projects/{project_id}/deliveries/{delivery_id}/files/{category}/{storage_name}")
async def get_generation_delivery_file(
    project_id: str,
    delivery_id: str,
    category: str,
    storage_name: str,
):
    file_path = await generation_holding_service.get_delivery_file_path(
        project_id,
        delivery_id,
        category,
        storage_name,
    )
    if file_path is None:
        raise HTTPException(status_code=404, detail="Delivery file not found")
    return FileResponse(file_path)


@router.websocket("/ws")
async def generation_delivery_websocket(ws: WebSocket):
    project_id = ws.query_params.get("projectId", "").strip()
    if not project_id:
        await ws.accept()
        await ws.close(code=1008, reason="projectId is required")
        return
    await generation_holding_service.attach_consumer(project_id, ws)
