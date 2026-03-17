import glob
from pathlib import Path
from typing import TypedDict

from config import SAM2_SEARCH_PATHS

class Sam2ModelInfo(TypedDict):
    name: str
    checkpoint_path: str
    config_path: str


def _find_sam2_package_config_dir() -> Path | None:
    try:
        import sam2
    except ImportError:
        return None

    pkg_path = Path(sam2.__file__).parent
    config_dir = pkg_path / "configs"
    if config_dir.exists() and config_dir.is_dir():
        return config_dir
    return None


def _infer_config_candidates(checkpoint_name: str) -> list[str]:
    """
    Infers config filename candidates based on the checkpoint name.

    For SAM 2.1 checkpoints, prefer `sam2.1_*` and then fallback to `sam2_*`
    when only legacy configs are present in the installed package.
    """
    lower_name = checkpoint_name.lower()
    variant = "l"

    if "sam2.1" in lower_name or "sam_2.1" in lower_name:
        if "base_plus" in lower_name or "_b+" in lower_name:
            variant = "b+"
        elif "small" in lower_name or "_s" in lower_name:
            variant = "s"
        elif "tiny" in lower_name or "_t" in lower_name:
            variant = "t"
        return [f"sam2.1_hiera_{variant}.yaml", f"sam2_hiera_{variant}.yaml"]

    if "base_plus" in lower_name or "_b+" in lower_name:
        variant = "b+"
    elif "small" in lower_name or "_s" in lower_name:
        variant = "s"
    elif "tiny" in lower_name or "_t" in lower_name:
        variant = "t"
    return [f"sam2_hiera_{variant}.yaml"]


def _resolve_config_path(model_file: Path) -> str:
    """
    Resolves a model config from:
    1) same-stem co-located yaml,
    2) inferred config filenames across local search roots and sam2 package configs,
    3) inferred filename fallback for Hydra package-based resolution.
    """
    co_located_config = model_file.with_suffix(".yaml")
    if co_located_config.exists():
        return str(co_located_config)

    config_candidates = _infer_config_candidates(model_file.name)
    search_roots: list[Path] = [model_file.parent]
    for search_root in SAM2_SEARCH_PATHS:
        if search_root not in search_roots:
            search_roots.append(search_root)

    package_config_dir = _find_sam2_package_config_dir()
    if package_config_dir is not None and package_config_dir not in search_roots:
        search_roots.append(package_config_dir)

    for config_name in config_candidates:
        for root in search_roots:
            config_path = root / config_name
            if config_path.exists():
                return str(config_path)

    return config_candidates[0]


def discover_sam2_models() -> list[Sam2ModelInfo]:
    """
    Scans SAM2_SEARCH_PATHS for SAM2 model files and determines their configs.
    """
    models: list[Sam2ModelInfo] = []
    seen_names: set[str] = set()
    
    valid_extensions = {".pt", ".pth", ".safetensors"}

    for search_dir in SAM2_SEARCH_PATHS:
        if not search_dir.exists() or not search_dir.is_dir():
            continue

        for ext in valid_extensions:
            # We skip recursive '**' searching for speed, usually models are right in the folder.
            for model_path in glob.glob(str(search_dir / f"*{ext}")):
                model_file = Path(model_path)
                model_name = model_file.name
                
                if model_name in seen_names:
                    continue
                
                models.append({
                    "name": model_name,
                    "checkpoint_path": str(model_file),
                    "config_path": _resolve_config_path(model_file),
                })
                seen_names.add(model_name)

    # Sort alphabetically by name
    models.sort(key=lambda x: x["name"].lower())
    return models
