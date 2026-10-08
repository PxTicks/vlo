import os
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

# Packaged installs keep mutable state outside the application. Source installs
# retain their existing paths unless they explicitly opt into VLO_DATA_DIR.
APP_ROOT = Path(__file__).resolve().parent.parent
_data_dir = os.environ.get("VLO_DATA_DIR", "").strip()
DATA_ROOT = Path(_data_dir).expanduser().resolve() if _data_dir else None
PROJECTS_ROOT = (DATA_ROOT or APP_ROOT) / "projects"
RUNTIME_ROOT = DATA_ROOT / "runtime" if DATA_ROOT else APP_ROOT / "backend" / "runtime"
USER_ASSETS_ROOT = DATA_ROOT / "assets" if DATA_ROOT else APP_ROOT / "backend" / "assets"
EXTENSIONS_HOME = (DATA_ROOT or APP_ROOT) / "extensions"
EXTENSIONS_ROOT = Path(
    os.environ.get(
        "VLO_EXTENSIONS_ROOT",
        str(EXTENSIONS_HOME / "installed"),
    )
).expanduser().resolve()
EXTENSION_STATE_DIR = Path(
    os.environ.get(
        "VLO_EXTENSION_STATE_DIR",
        str(RUNTIME_ROOT / "extensions"),
    )
).expanduser().resolve()

# Ensure the root projects directory exists
PROJECTS_ROOT.mkdir(parents=True, exist_ok=True)
RUNTIME_ROOT.mkdir(parents=True, exist_ok=True)

# ComfyUI configuration
COMFYUI_URL = os.environ.get("COMFYUI_URL", "http://127.0.0.1:8188")
_comfyui_install_dir = os.environ.get("COMFYUI_INSTALL_DIR", "").strip()
COMFYUI_INSTALL_DIR = (
    Path(_comfyui_install_dir).expanduser() if _comfyui_install_dir else None
)

SAM2_DEVICE = os.environ.get("SAM2_DEVICE", "auto").strip() or "auto"


def _read_nonnegative_int_env(name: str, default: int) -> int:
    raw_value = os.environ.get(name, "").strip()
    if not raw_value:
        return default
    try:
        value = int(raw_value)
    except ValueError:
        return default
    return value if value >= 0 else default


SAM2_MAX_PROPAGATION_FRAMES = _read_nonnegative_int_env(
    "SAM2_MAX_PROPAGATION_FRAMES",
    900,
)

SAM2_CACHE_DIR = Path(
    os.environ.get("SAM2_CACHE_DIR", str(PROJECTS_ROOT / ".sam2_cache"))
)
SAM2_CACHE_DIR.mkdir(parents=True, exist_ok=True)

SAM_AUDIO_DEVICE = os.environ.get("SAM_AUDIO_DEVICE", "auto").strip() or "auto"
SAM_AUDIO_DEFAULT_MODEL = (
    os.environ.get("SAM_AUDIO_MODEL", "sam-audio-large-tv").strip()
    or "sam-audio-large-tv"
)
SAM_AUDIO_CACHE_DIR = Path(
    os.environ.get("SAM_AUDIO_CACHE_DIR", str(PROJECTS_ROOT / ".sam_audio_cache"))
)
SAM_AUDIO_CACHE_DIR.mkdir(parents=True, exist_ok=True)
SAM_AUDIO_MODEL_DIR = Path(
    os.environ.get(
        "SAM_AUDIO_MODEL_DIR",
        str(USER_ASSETS_ROOT / "models" / "sam_audio"),
    )
)
SAM_AUDIO_MODEL_DIR.mkdir(parents=True, exist_ok=True)
SAM_AUDIO_SEARCH_PATHS: list[Path] = [SAM_AUDIO_MODEL_DIR]
SAM_AUDIO_LOAD_OPTIONAL_MODELS = (
    os.environ.get("SAM_AUDIO_LOAD_OPTIONAL_MODELS", "0").strip().lower()
    in {"1", "true", "yes", "on"}
)

BEATTHIS_DEVICE = os.environ.get("BEATTHIS_DEVICE", "auto").strip() or "auto"
BEATTHIS_DEFAULT_MODEL = (
    os.environ.get("BEATTHIS_MODEL", "final0").strip() or "final0"
)
BEATTHIS_CACHE_DIR = Path(
    os.environ.get("BEATTHIS_CACHE_DIR", str(PROJECTS_ROOT / ".beat_this_cache"))
)
BEATTHIS_CACHE_DIR.mkdir(parents=True, exist_ok=True)
# Steer Beat This! / torch.hub auto-downloads into our cache dir.
os.environ.setdefault("TORCH_HOME", str(BEATTHIS_CACHE_DIR / "torch"))

SAM2_SEARCH_PATHS: list[Path] = [USER_ASSETS_ROOT / "models" / "sams"]
# User configuration, so it moves with the data folder: a portable update
# replaces the application folder wholesale.
EXTRA_MODEL_PATHS_FILE = (DATA_ROOT or APP_ROOT) / "extra_model_paths.yaml"

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
                        if "sam_audio" in comfyui_conf:
                            sam_audio_val = comfyui_conf["sam_audio"]
                            sam_audio_list = (
                                [sam_audio_val]
                                if isinstance(sam_audio_val, str)
                                else sam_audio_val
                            )
                            for p in sam_audio_list:
                                SAM_AUDIO_SEARCH_PATHS.append(base_path / p)

                # Custom Folders handling
                if "custom_folders" in extra_paths and isinstance(extra_paths["custom_folders"], dict):
                    custom_conf = extra_paths["custom_folders"]
                    if "sams" in custom_conf:
                        sams_val = custom_conf["sams"]
                        sams_list = [sams_val] if isinstance(sams_val, str) else sams_val
                        for p in sams_list:
                            SAM2_SEARCH_PATHS.append(Path(p))
                    if "sam_audio" in custom_conf:
                        sam_audio_val = custom_conf["sam_audio"]
                        sam_audio_list = (
                            [sam_audio_val]
                            if isinstance(sam_audio_val, str)
                            else sam_audio_val
                        )
                        for p in sam_audio_list:
                            SAM_AUDIO_SEARCH_PATHS.append(Path(p))
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
