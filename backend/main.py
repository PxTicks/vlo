import httpx
from contextlib import asynccontextmanager
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
from services.ai_models.health import AppStatusProvider
from services.model_registry import (
    get_available_sam2_models,
    get_available_sam_audio_models,
    is_comfyui_model_downloads_enabled,
)
from services.sam2 import sam2_service
from services.sam_audio import sam_audio_service
from services.beats import beats_service


@asynccontextmanager
async def application_lifespan(application: FastAPI):
    runtime = get_extension_services().backend_runtime
    try:
        await runtime.start(application)
        yield
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


BASE_DIR = Path(__file__).resolve().parent.parent
PROJECTS_DIR = BASE_DIR / "projects"
FRONTEND_DIST_DIR = BASE_DIR / "frontend" / "dist"
FRONTEND_INDEX_FILE = FRONTEND_DIST_DIR / "index.html"

AI_APP_STATUS_PROVIDERS = [
    AppStatusProvider(
        response_key="sam2",
        health_fn=lambda: sam2_service.get_health(),
        unavailable_message="No SAM2 models discovered",
        installed_models_fn=lambda: get_available_sam2_models(),
    ),
    AppStatusProvider(
        response_key="sam_audio",
        health_fn=lambda: sam_audio_service.get_health(),
        unavailable_message="No SAM-Audio model configured",
        use_runtime_error=True,
        installed_models_fn=lambda: get_available_sam_audio_models(),
    ),
    AppStatusProvider(
        response_key="beat_this",
        health_fn=lambda: beats_service.get_health(),
        unavailable_message="Beat This! is not installed",
        use_runtime_error=True,
    ),
]

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

    ai_statuses = {
        provider.response_key: provider.to_app_status()
        for provider in AI_APP_STATUS_PROVIDERS
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
