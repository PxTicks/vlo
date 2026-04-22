from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException, WebSocket
from fastapi.responses import FileResponse

from services.generation_delivery import generation_holding_service

router = APIRouter(prefix="/app/generation-delivery", tags=["generation-delivery"])


@router.get("/projects/{project_id}/pending")
async def list_pending_generation_deliveries(project_id: str):
    return {
        "project_id": project_id,
        "deliveries": await generation_holding_service.list_project_deliveries(project_id),
    }


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
