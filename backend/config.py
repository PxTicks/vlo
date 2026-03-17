import os
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

# This sets the root 'projects' folder relative to this backend directory
# Adjust .parent.parent if you want it outside the backend folder
PROJECTS_ROOT = Path(__file__).parent.parent / "projects"

# Ensure the root projects directory exists
PROJECTS_ROOT.mkdir(exist_ok=True)

# ComfyUI configuration
COMFYUI_URL = os.environ.get("COMFYUI_URL", "http://127.0.0.1:8188")

SAM2_DEVICE = os.environ.get("SAM2_DEVICE", "auto").strip() or "auto"

SAM2_CACHE_DIR = Path(
    os.environ.get("SAM2_CACHE_DIR", str(PROJECTS_ROOT / ".sam2_cache"))
)
SAM2_CACHE_DIR.mkdir(parents=True, exist_ok=True)

SAM2_SEARCH_PATHS: list[Path] = [Path(__file__).parent / "assets" / "models" / "sams"]
EXTRA_MODEL_PATHS_FILE = Path(__file__).parent.parent / "extra_model_paths.yaml"

if EXTRA_MODEL_PATHS_FILE.exists():
    try:
        import yaml

        with open(EXTRA_MODEL_PATHS_FILE, "r") as f:
            extra_paths = yaml.safe_load(f)

            if extra_paths:
                # ComfyUI base_path handling
                if "comfyui" in extra_paths and isinstance(extra_paths["comfyui"], dict):
                    comfyui_conf = extra_paths["comfyui"]
                    base_path_str = comfyui_conf.get("base_path")
                    if base_path_str:
                        base_path = Path(base_path_str)
                        if "sams" in comfyui_conf:
                            sams_val = comfyui_conf["sams"]
                            # ComfyUI can define this as a path string or a list of paths
                            sams_list = [sams_val] if isinstance(sams_val, str) else sams_val
                            for p in sams_list:
                                SAM2_SEARCH_PATHS.append(base_path / p)

                # Custom Folders handling
                if "custom_folders" in extra_paths and isinstance(extra_paths["custom_folders"], dict):
                    custom_conf = extra_paths["custom_folders"]
                    if "sams" in custom_conf:
                        sams_val = custom_conf["sams"]
                        sams_list = [sams_val] if isinstance(sams_val, str) else sams_val
                        for p in sams_list:
                            SAM2_SEARCH_PATHS.append(Path(p))
    except Exception as e:
        print(f"Warning: Failed to parse {EXTRA_MODEL_PATHS_FILE}: {e}")

# Backend CORS configuration for direct backend access in local/dev workflows.
# In the normal Paperspace setup, browser traffic stays same-origin via Nginx.
CORS_ALLOW_ORIGINS = [
    origin.strip()
    for origin in os.environ.get("CORS_ALLOW_ORIGINS", "http://localhost:5173").split(",")
    if origin.strip()
]
CORS_ALLOW_ORIGIN_REGEX = os.environ.get("CORS_ALLOW_ORIGIN_REGEX", "").strip() or None
