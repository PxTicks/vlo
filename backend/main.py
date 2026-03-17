import httpx
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from config import PROJECTS_ROOT, CORS_ALLOW_ORIGINS, CORS_ALLOW_ORIGIN_REGEX
from services.legacy_core import project_service, asset_service
from models import ProjectCreateRequest, ProjectResponse, AssetResponse, ProjectUpdateRequest
from fastapi.responses import FileResponse
from services.legacy_core.project_service import get_project_path_by_id
from routers.comfyui import (
    router as comfyui_router,
    compat_router as comfyui_compat_router,
    close_http_client,
)
from routers.sam2 import router as sam2_router
from pathlib import Path
from typing import List

from services.comfyui.comfyui_client import (
    get_comfyui_url,
    get_comfyui_url_error,
    get_http_client,
)
from services.sam2 import sam2_service

app = FastAPI()

app.include_router(comfyui_router)
app.include_router(comfyui_compat_router)
app.include_router(sam2_router)


@app.on_event("shutdown")
async def shutdown():
    await close_http_client()


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

@app.post("/projects/{project_id}/assets", response_model=AssetResponse)
async def upload_asset(project_id: str, file: UploadFile = File(...)):
    try:
        asset = await asset_service.process_upload(project_id, file)
        return asset
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Project not found")
    
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

@app.post("/projects/{project_id}/assets/sync", response_model=List[AssetResponse])
def sync_project_assets(project_id: str):
    """
    Forces a disk scan to find orphan files and add them to the project.json
    """
    try:
        return asset_service.scan_project_assets(project_id)
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

    if not comfyui_config_error:
        try:
            client = await get_http_client()
            await client.get(
                "/system_stats",
                timeout=httpx.Timeout(5.0, connect=2.0),
            )
            comfyui_status = "connected"
            comfyui_error = None
        except (httpx.RequestError, ValueError) as exc:
            comfyui_status = "disconnected"
            comfyui_error = str(exc)

    try:
        sam2_health = sam2_service.get_health()
        sam2_ready = bool(
            (sam2_health.get("runtime") or {}).get("ready")
        )
        sam2_status = "available" if sam2_ready else "unavailable"
        sam2_error = None if sam2_ready else "No SAM2 models discovered"
    except Exception as exc:  # pragma: no cover - defensive status fallback
        sam2_status = "unavailable"
        sam2_error = str(exc)

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
        },
        "sam2": {
            "status": sam2_status,
            "error": sam2_error,
        },
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
