import asyncio
import logging

import httpx
from contextlib import asynccontextmanager, suppress
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from config import (
    PROJECTS_ROOT,
    CORS_ALLOW_ORIGINS,
    CORS_ALLOW_ORIGIN_REGEX,
)
from services.legacy_core import project_service
from models import ProjectCreateRequest, ProjectResponse, AssetResponse, ProjectUpdateRequest
from fastapi.responses import FileResponse
from services.legacy_core.project_service import get_project_path_by_id
from routers.comfyui import (
    router as comfyui_router,
    compat_router as comfyui_compat_router,
    close_http_client,
)
from routers.sam2 import router as sam2_router
from routers.sam_audio import router as sam_audio_router
from routers.beats import router as beats_router
from routers.downloads import router as downloads_router
from routers.generation_delivery import router as generation_delivery_router
from routers.runtime_capabilities import router as runtime_capabilities_router
from routers.app_lifecycle import router as app_lifecycle_router
from routers.app_settings import (
    build_public_settings_payload,
    router as app_settings_router,
)
from routers.extensions import (
    get_extension_services,
    router as extensions_router,
)
from pathlib import Path
from typing import List

from services.comfyui.comfyui_client import (
    get_comfyui_url,
    get_comfyui_url_error,
    get_http_client,
)
from services.hardware import detect_local_vram, detect_vram_from_system_stats
from services.ai_models.capabilities.install_jobs import (
    shutdown_runtime_capability_install_jobs,
)
from services.ai_models.capabilities.load_probes import (
    shutdown_runtime_capability_probe_jobs,
)
from services.ai_models.health import app_status_providers
from services.model_registry import is_comfyui_model_downloads_enabled
from services.gen_pipeline.prepared_media import sweep_prepared_media
from services.generation_delivery import generation_holding_service
from services.model_work import get_model_work_coordinator
from services.sam_audio import sam_audio_service


MODEL_WORK_RESTORE_RETRY_BASE_SECONDS = 5.0
MODEL_WORK_RESTORE_RETRY_MAX_SECONDS = 60.0


async def _try_restore_model_work_state() -> bool:
    """Rebuild GPU occupancy from persisted deliveries, then open admission.

    Returns whether admission was opened. **Failure must not open it.** If the
    persisted in-flight prompts cannot be rebuilt, vlo does not know what
    ComfyUI is still executing, and admitting local inference on that guess is
    exactly the collision this system exists to prevent.
    """
    try:
        await generation_holding_service.restore_in_flight_work()
    except Exception:
        logging.getLogger(__name__).exception(
            "Failed to restore in-flight generation deliveries; GPU admission "
            "stays closed (503) until this succeeds"
        )
        return False
    get_model_work_coordinator().mark_ready()
    return True


async def _retry_model_work_restore_forever() -> None:
    """Keep retrying a failed restore so a transient fault is not permanent.

    The rest of the editor works while this runs; only GPU work answers 503.
    """
    delay = MODEL_WORK_RESTORE_RETRY_BASE_SECONDS
    while True:
        await asyncio.sleep(delay)
        if await _try_restore_model_work_state():
            logging.getLogger(__name__).info(
                "Model-work restore succeeded on retry; GPU admission is open"
            )
            return
        delay = min(delay * 2, MODEL_WORK_RESTORE_RETRY_MAX_SECONDS)


@asynccontextmanager
async def application_lifespan(application: FastAPI):
    runtime = get_extension_services().backend_runtime
    restore_retry: asyncio.Task[None] | None = None
    try:
        # Prepared-media groups are a submission-time accelerator, not state
        # anything depends on. A backend that stopped mid-batch leaves its bytes
        # behind with nothing scheduled to collect them, so retire them here.
        try:
            sweep_prepared_media()
        except Exception:
            logging.getLogger(__name__).warning(
                "Failed to sweep retained prepared media", exc_info=True
            )
        # The model-work coordinator starts *not ready* and refuses admission
        # (503) until in-flight ComfyUI prompts have been rebuilt as occupancy.
        # Without this a restart could admit local inference alongside prompts
        # ComfyUI never stopped executing.
        if not await _try_restore_model_work_state():
            restore_retry = asyncio.create_task(_retry_model_work_restore_forever())
        await runtime.start(application)
        yield
    finally:
        if restore_retry is not None:
            restore_retry.cancel()
            with suppress(asyncio.CancelledError):
                await restore_retry
        try:
            await shutdown_runtime_capability_probe_jobs()
        finally:
            try:
                await shutdown_runtime_capability_install_jobs()
            finally:
                try:
                    await sam_audio_service.shutdown_jobs()
                finally:
                    try:
                        await runtime.stop()
                    finally:
                        await close_http_client()


app = FastAPI(lifespan=application_lifespan)

app.include_router(comfyui_router)
app.include_router(comfyui_compat_router)
app.include_router(sam2_router)
app.include_router(sam_audio_router)
app.include_router(beats_router)
app.include_router(downloads_router)
app.include_router(generation_delivery_router)
app.include_router(extensions_router)
app.include_router(app_settings_router)
app.include_router(runtime_capabilities_router)
app.include_router(app_lifecycle_router)


BASE_DIR = Path(__file__).resolve().parent.parent
PROJECTS_DIR = BASE_DIR / "projects"
FRONTEND_DIST_DIR = BASE_DIR / "frontend" / "dist"
FRONTEND_INDEX_FILE = FRONTEND_DIST_DIR / "index.html"

app.mount("/static", StaticFiles(directory=str(PROJECTS_DIR)), name="static")

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ALLOW_ORIGINS,
    allow_origin_regex=CORS_ALLOW_ORIGIN_REGEX,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve the projects folder statically so the frontend can play videos
# URL will be: http://localhost:6332/static/<project_id>/<filename>
@app.get("/projects/{project_id}/assets/{filename}")
async def get_asset(project_id: str, filename: str):
    try:
        project_path = get_project_path_by_id(project_id)
        asset_file = project_path / "assets" / filename
        
        if not asset_file.exists():
            raise HTTPException(status_code=404, detail="Asset not found")
            
        return FileResponse(asset_file)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Project not found")
    
@app.post("/projects", response_model=ProjectResponse)
def create_project(request: ProjectCreateRequest):
    try:
        result = project_service.create_project_structure(
            request.id, request.title, request.created_at
        )
        return {
            "id": request.id,
            "title": request.title,
            "root_path": result["path"]
        }
    except FileExistsError as e:
        raise HTTPException(status_code=409, detail=str(e))

@app.patch("/projects/{project_id}")
def update_project(project_id: str, request: ProjectUpdateRequest):
    try:
        result = project_service.update_project_title(project_id, request.title)
        return result
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Project not found")
    except OSError as e:
        raise HTTPException(status_code=409, detail=str(e))

@app.get("/projects/{project_id}")
def get_project_details(project_id: str):
    try:
        # Reuses your existing logic which throws error if missing
        project_path = project_service.get_project_path_by_id(project_id)
        return {"id": project_id, "exists": True}
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Project not found")
    
@app.get("/projects/{project_id}/assets", response_model=List[AssetResponse])
def get_project_assets(project_id: str):
    """
    Returns the asset catalog. 
    Triggers a light scan or just reads JSON?
    For performance, just read JSON. Let the user trigger 'Sync' manually or on load.
    """
    try:
        return project_service.get_project_assets(project_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Project not found")

@app.get("/app/status")
async def get_app_status():
    frontend_build_present = FRONTEND_INDEX_FILE.exists()
    app_mode = "production" if frontend_build_present else "development"

    comfyui_url = get_comfyui_url()
    comfyui_config_error = get_comfyui_url_error()
    comfyui_status = "invalid_config" if comfyui_config_error else "disconnected"
    comfyui_error = comfyui_config_error
    vram_info = detect_local_vram()

    if not comfyui_config_error:
        try:
            client = await get_http_client()
            system_stats_response = await client.get(
                "/system_stats",
                timeout=httpx.Timeout(5.0, connect=2.0),
            )
            comfyui_status = "connected"
            comfyui_error = None
            system_stats = (
                system_stats_response.json()
                if hasattr(system_stats_response, "json")
                else system_stats_response
            )
            if isinstance(system_stats, dict):
                comfyui_vram_info = detect_vram_from_system_stats(system_stats)
                if comfyui_vram_info.total_mb is not None:
                    vram_info = comfyui_vram_info
        except (httpx.RequestError, ValueError) as exc:
            comfyui_status = "disconnected"
            comfyui_error = str(exc)

    # Legacy status fields, derived from the runtime-capability registry rather
    # than from model inventory: a checkpoint on disk is discovery, not
    # readiness. The list is read from the descriptor table per request, not
    # snapshotted at import — a capability registered after start-up has to
    # reach this response the same way a built-in one does. Building it costs a
    # tuple of frozen dataclasses.
    ai_statuses = {
        provider.response_key: provider.to_app_status()
        for provider in app_status_providers()
    }
    settings_payload = build_public_settings_payload(vram_info)

    return {
        "backend": {
            "status": "ok",
            "mode": app_mode,
            "frontendBuildPresent": frontend_build_present,
        },
        "comfyui": {
            "status": comfyui_status,
            "url": comfyui_url,
            "error": comfyui_error,
            "modelDownloadsEnabled": is_comfyui_model_downloads_enabled(),
        },
        "settings": settings_payload["settings"],
        "hardware": settings_payload["hardware"],
        "recommendations": settings_payload["recommendations"],
        **ai_statuses,
    }


def _resolve_frontend_file(full_path: str) -> Path | None:
    if not FRONTEND_INDEX_FILE.exists():
        return None

    normalized = full_path.lstrip("/")
    if not normalized:
        return FRONTEND_INDEX_FILE

    candidate = (FRONTEND_DIST_DIR / normalized).resolve()
    dist_root = FRONTEND_DIST_DIR.resolve()
    if dist_root not in candidate.parents:
        return None
    if candidate.is_file():
        return candidate
    return FRONTEND_INDEX_FILE


if FRONTEND_INDEX_FILE.exists():
    @app.get("/", include_in_schema=False)
    async def serve_frontend_index():
        return FileResponse(FRONTEND_INDEX_FILE)


    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_frontend_app(full_path: str):
        file_path = _resolve_frontend_file(full_path)
        if file_path is None:
            raise HTTPException(status_code=404, detail="Not found")
        return FileResponse(file_path)
