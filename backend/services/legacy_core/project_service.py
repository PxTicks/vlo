import json
import re
import os
import uuid
import time
import urllib.parse  # <--- NEW IMPORT
from pathlib import Path
from config import PROJECTS_ROOT

REGISTRY_FILE = PROJECTS_ROOT / "projects_registry.json"
PROJECT_CONFIG_FILENAME = "project.json"

# --- Registry Logic ---

def _rebuild_registry() -> dict:
    print("⚠️ Registry not found. Rebuilding from disk...")
    new_registry = {}
    PROJECTS_ROOT.mkdir(exist_ok=True)

    for entry in PROJECTS_ROOT.iterdir():
        if entry.is_dir():
            config_path = entry / PROJECT_CONFIG_FILENAME
            if config_path.exists():
                try:
                    with open(config_path, "r") as f:
                        data = json.load(f)
                        if "id" in data:
                            new_registry[data["id"]] = entry.name
                except json.JSONDecodeError:
                    print(f"Skipping corrupted config in {entry.name}")
            else:
                print(f"Found orphan folder: {entry.name}. creating config...")
                new_id = str(uuid.uuid4())
                config_data = {
                    "id": new_id,
                    "title": entry.name,
                    "created_at": int(time.time() * 1000),
                    "version": "1.0.0",
                    "reconstructed": True
                }
                with open(config_path, "w") as f:
                    json.dump(config_data, f, indent=2)
                new_registry[new_id] = entry.name

    with open(REGISTRY_FILE, "w") as f:
        json.dump({"projects": new_registry}, f, indent=2)
    return new_registry

def _load_registry() -> dict:
    if not REGISTRY_FILE.exists():
        return _rebuild_registry()
    try:
        with open(REGISTRY_FILE, "r") as f:
            data = json.load(f)
            return data.get("projects", {})
    except (json.JSONDecodeError, OSError):
        return _rebuild_registry()

def _save_to_registry(project_id: str, folder_name: str):
    current_projects = _load_registry()
    current_projects[project_id] = folder_name
    with open(REGISTRY_FILE, "w") as f:
        json.dump({"projects": current_projects}, f, indent=2)

# --- Public Methods ---

def get_project_path_by_id(project_id: str) -> Path:
    registry = _load_registry()
    folder_name = registry.get(project_id)
    if not folder_name:
        raise FileNotFoundError(f"Project ID {project_id} not found.")
    
    project_path = PROJECTS_ROOT / folder_name
    if not project_path.exists():
        raise FileNotFoundError(f"Project folder '{folder_name}' missing.")
    return project_path

def create_project_structure(project_id: str, title: str, created_at: int):
    registry = _load_registry()
    if project_id in registry:
        folder_name = registry[project_id]
        project_path = PROJECTS_ROOT / folder_name
        return {
            "path": str(project_path),
            "config_file": str(project_path / PROJECT_CONFIG_FILENAME)
        }

    project_path = _get_unique_path(PROJECTS_ROOT, title)
    folder_name = project_path.name 
    
    assets_path = project_path / "assets"
    project_path.mkdir(parents=True, exist_ok=True)
    assets_path.mkdir(exist_ok=True)

    config_data = {
        "id": project_id,
        "title": title,
        "created_at": created_at,
        "version": "1.0.0"
    }
    
    with open(project_path / PROJECT_CONFIG_FILENAME, "w") as f:
        json.dump(config_data, f, indent=2)

    _save_to_registry(project_id, folder_name)

    return {
        "path": str(project_path),
        "config_file": str(project_path / PROJECT_CONFIG_FILENAME)
    }

def update_project_title(project_id: str, new_title: str):
    """
    Renames the project folder and updates internal asset URLs.
    """
    current_path = get_project_path_by_id(project_id)
    new_path = _get_unique_path(PROJECTS_ROOT, new_title)
    
    renamed = False
    
    # 1. Rename Directory on Disk
    if new_path.name != current_path.name:
        try:
            current_path.rename(new_path)
            renamed = True
        except OSError as e:
            raise OSError(f"Could not rename folder. It might be open in another program. {e}")

    final_path = new_path if renamed else current_path
    config_path = final_path / PROJECT_CONFIG_FILENAME
    
    # 2. Update project.json
    if config_path.exists():
        with open(config_path, "r+") as f:
            data = json.load(f)
            data["title"] = new_title
            data["last_modified"] = int(time.time() * 1000)
            
            # --- URL REWRITE FIX ---
            if renamed and "assets" in data:
                # Calculate new base URL
                encoded_folder = urllib.parse.quote(final_path.name)
                base_url = f"http://localhost:6332/static/{encoded_folder}/assets"
                
                print(f"Updating asset URLs to: {base_url}")

                for asset in data["assets"].values():
                    # Update 'src'
                    asset["src"] = f"{base_url}/{asset['name']}"
                    
                    # Update 'thumbnail' if it exists
                    if asset.get("thumbnail"):
                        # Extract filename from old URL (e.g. "thumb.jpg")
                        old_thumb_url = asset["thumbnail"]
                        thumb_filename = old_thumb_url.split("/")[-1]
                        asset["thumbnail"] = f"{base_url}/thumbnails/{thumb_filename}"

            f.seek(0)
            json.dump(data, f, indent=2)
            f.truncate()
            
    if renamed:
        _save_to_registry(project_id, final_path.name)
        
    return {
        "id": project_id,
        "new_title": new_title,
        "new_root_path": str(final_path),
        "new_folder_name": final_path.name
    }

def get_project_assets(project_id: str) -> list:
    project_path = get_project_path_by_id(project_id)
    config_path = project_path / PROJECT_CONFIG_FILENAME
    if not config_path.exists():
        return []
    with open(config_path, "r") as f:
        data = json.load(f)
        return list(data.get("assets", {}).values())

def register_asset(project_id: str, asset_data: dict):
    project_path = get_project_path_by_id(project_id)
    config_path = project_path / PROJECT_CONFIG_FILENAME
    with open(config_path, "r+") as f:
        data = json.load(f)
        if "assets" not in data:
            data["assets"] = {}
        data["assets"][asset_data["id"]] = asset_data
        data["last_modified"] = int(time.time() * 1000)
        f.seek(0)
        json.dump(data, f, indent=2)
        f.truncate()

def remove_asset_entry(project_id: str, asset_id: str):
    project_path = get_project_path_by_id(project_id)
    config_path = project_path / PROJECT_CONFIG_FILENAME
    with open(config_path, "r+") as f:
        data = json.load(f)
        if "assets" in data and asset_id in data["assets"]:
            del data["assets"][asset_id]
            f.seek(0)
            json.dump(data, f, indent=2)
            f.truncate()

def _sanitize_filename(name: str) -> str:
    sanitized = re.sub(r'[^\w\s-]', '', name).strip()
    sanitized = re.sub(r'[-\s]+', '_', sanitized)
    return sanitized[:50] or "project"

def _get_unique_path(base_path: Path, title: str) -> Path:
    safe_title = _sanitize_filename(title) or "unnamed_project"
    target_path = base_path / safe_title
    counter = 1
    while target_path.exists():
        target_path = base_path / f"{safe_title} ({counter})"
        counter += 1
    return target_path
