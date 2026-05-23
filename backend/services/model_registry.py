"""Registry of downloadable models.

Maps human-friendly model keys to their download URLs and destination paths.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from config import COMFYUI_INSTALL_DIR, SAM2_SEARCH_PATHS
from services.download_service import DownloadFileSpec
from services.sam2.sam2_discovery import discover_sam2_models

_HF_RESOLVE = "https://huggingface.co/{repo}/resolve/main/{filename}"
_WORKFLOWS_DIR = Path(__file__).parent.parent / "assets" / "workflows"
_DEFAULT_WORKFLOWS_DIR = (
    Path(__file__).parent.parent / "assets" / ".config" / "default_workflows"
)

# black-forest-labs FLUX.1/FLUX.2 repos are gated on HuggingFace (the user
# must accept the license before downloading), except for FLUX.1-schnell and
# any FLUX.2-klein 4B variant, which are released openly.
_GATED_FLUX_REPO_PATTERN = re.compile(
    r"^black-forest-labs/FLUX\.[12]-",
    re.IGNORECASE,
)
_OPEN_FLUX_REPO_EXCEPTIONS = (
    re.compile(r"^black-forest-labs/FLUX\.1-schnell$", re.IGNORECASE),
    re.compile(r"^black-forest-labs/FLUX\.2-klein-base-4b", re.IGNORECASE),
)

SAM2_MODELS: dict[str, dict] = {
    "sam2.1_hiera_large": {
        "label": "SAM2.1 Large",
        "description": "Higher quality, ~900 MB",
        "repo": "facebook/sam2.1-hiera-large",
        "files": [
            {"filename": "sam2.1_hiera_large.pt"},
            {"filename": "sam2.1_hiera_l.yaml"},
        ],
    },
    "sam2.1_hiera_small": {
        "label": "SAM2.1 Small",
        "description": "Faster, ~185 MB",
        "repo": "facebook/sam2.1-hiera-small",
        "files": [
            {"filename": "sam2.1_hiera_small.pt"},
            {"filename": "sam2.1_hiera_s.yaml"},
        ],
    },
}


def is_comfyui_model_downloads_enabled() -> bool:
    return COMFYUI_INSTALL_DIR is not None


def _is_safe_workflow_filename(filename: str) -> bool:
    return not (
        ".." in filename
        or "/" in filename
        or "\\" in filename
        or filename.strip() == ""
    )


def _resolve_workflow_path(filename: str) -> Path | None:
    main = _WORKFLOWS_DIR / filename
    if main.exists():
        return main
    default = _DEFAULT_WORKFLOWS_DIR / filename
    if default.exists():
        return default
    return None


def _normalize_relative_directory(directory: str) -> str:
    normalized = directory.strip().replace("\\", "/").strip("/")
    if not normalized:
        raise ValueError("Workflow model directory is missing")

    parts = [part for part in normalized.split("/") if part and part != "."]
    if not parts or any(part == ".." for part in parts):
        raise ValueError(f"Invalid workflow model directory: {directory}")

    return "/".join(parts)


def _normalize_filename(filename: str) -> str:
    normalized = filename.strip()
    if not normalized:
        raise ValueError("Workflow model filename is missing")

    candidate = Path(normalized)
    if candidate.name != normalized or any(part in {"", ".", ".."} for part in candidate.parts):
        raise ValueError(f"Invalid workflow model filename: {filename}")

    return normalized


def _load_workflow_json(workflow_id: str) -> dict[str, Any]:
    if not _is_safe_workflow_filename(workflow_id):
        raise ValueError(f"Invalid workflow filename: {workflow_id}")

    workflow_path = _resolve_workflow_path(workflow_id)
    if workflow_path is None:
        raise ValueError(f"Workflow not found: {workflow_id}")

    try:
        workflow = json.loads(workflow_path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise ValueError(f"Failed to read workflow {workflow_id}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"Workflow {workflow_id} is not valid JSON") from exc

    if not isinstance(workflow, dict):
        raise ValueError(f"Workflow {workflow_id} is not a JSON object")

    return workflow


def _iter_workflow_nodes(workflow: dict[str, Any]) -> list[dict[str, Any]]:
    raw_nodes = workflow.get("nodes")
    if isinstance(raw_nodes, list):
        return [node for node in raw_nodes if isinstance(node, dict)]

    return [
        node
        for node in workflow.values()
        if isinstance(node, dict)
        and isinstance(node.get("properties"), dict)
    ]


def _build_workflow_model_key(directory: str, filename: str) -> str:
    return f"{directory}:{filename}"


def _parse_hf_repo(url: str) -> tuple[str, str, str] | None:
    try:
        parsed = urlparse(url)
    except ValueError:
        return None
    if parsed.scheme not in ("http", "https") or parsed.netloc != "huggingface.co":
        return None

    segments = [segment for segment in parsed.path.split("/") if segment]
    if len(segments) < 2:
        return None

    owner, repo_name = segments[0], segments[1]
    return owner, repo_name, f"{parsed.scheme}://{parsed.netloc}/{owner}/{repo_name}"


def _is_gated_flux_url(url: str) -> bool:
    repo_info = _parse_hf_repo(url)
    if repo_info is None:
        return False
    owner, repo_name, _repo_url = repo_info
    repo = f"{owner}/{repo_name}"
    if not _GATED_FLUX_REPO_PATTERN.match(repo):
        return False
    return not any(exception.match(repo) for exception in _OPEN_FLUX_REPO_EXCEPTIONS)


def _gated_repo_url_for(url: str) -> str | None:
    repo_info = _parse_hf_repo(url)
    if repo_info is None:
        return None
    _owner, _repo_name, repo_url = repo_info
    return repo_url


def _extract_workflow_models(workflow: dict[str, Any]) -> list[dict[str, Any]]:
    unique_models: dict[str, dict[str, Any]] = {}

    for node in _iter_workflow_nodes(workflow):
        properties = node.get("properties")
        if not isinstance(properties, dict):
            continue

        raw_models = properties.get("models")
        if not isinstance(raw_models, list):
            continue

        for raw_model in raw_models:
            if not isinstance(raw_model, dict):
                continue

            raw_name = raw_model.get("name")
            raw_url = raw_model.get("url")
            raw_directory = raw_model.get("directory")
            if not isinstance(raw_name, str) or not isinstance(raw_url, str):
                continue

            try:
                filename = _normalize_filename(raw_name)
                directory = _normalize_relative_directory(
                    raw_directory if isinstance(raw_directory, str) else "",
                )
            except ValueError:
                continue

            url = raw_url.strip()
            if not url.startswith(("http://", "https://")):
                continue

            key = _build_workflow_model_key(directory, filename)
            gated = _is_gated_flux_url(url)
            unique_models.setdefault(
                key,
                {
                    "key": key,
                    "label": filename,
                    "description": f"Save to ComfyUI/models/{directory}",
                    "installed": False,
                    "directory": directory,
                    "filename": filename,
                    "url": url,
                    "gated": gated,
                    "gatedRepoUrl": _gated_repo_url_for(url) if gated else None,
                },
            )

    return list(unique_models.values())


def get_sam2_download_specs(model_key: str) -> list[DownloadFileSpec]:
    model = SAM2_MODELS.get(model_key)
    if model is None:
        raise ValueError(f"Unknown SAM2 model key: {model_key}")

    dest_dir = str(SAM2_SEARCH_PATHS[0])
    repo = model["repo"]

    return [
        DownloadFileSpec(
            url=_HF_RESOLVE.format(repo=repo, filename=f["filename"]),
            dest_path=f"{dest_dir}/{f['filename']}",
            filename=f["filename"],
        )
        for f in model["files"]
    ]


def get_available_sam2_models() -> list[dict]:
    discovered = discover_sam2_models()
    discovered_names = {m["name"] for m in discovered}

    result = []
    for key, model in SAM2_MODELS.items():
        checkpoint_filename = next(
            f["filename"] for f in model["files"] if f["filename"].endswith(".pt")
        )
        result.append({
            "key": key,
            "label": model["label"],
            "description": model["description"],
            "installed": checkpoint_filename in discovered_names,
        })
    return result


def get_available_workflow_models(workflow_id: str) -> list[dict[str, Any]]:
    if not is_comfyui_model_downloads_enabled():
        return []

    workflow = _load_workflow_json(workflow_id)
    models = _extract_workflow_models(workflow)

    result: list[dict[str, Any]] = []
    for model in models:
        dest_path = (
            COMFYUI_INSTALL_DIR / "models" / model["directory"] / model["filename"]
            if COMFYUI_INSTALL_DIR is not None
            else None
        )
        installed = dest_path.is_file() if dest_path is not None else False
        result.append({
            "key": model["key"],
            "label": model["label"],
            "description": model["description"],
            "installed": installed,
            "directory": model["directory"],
            "filename": model["filename"],
            "gated": model["gated"],
            "gatedRepoUrl": model["gatedRepoUrl"],
        })
    return result


def is_workflow_model_gated(workflow_id: str, model_key: str) -> bool:
    if COMFYUI_INSTALL_DIR is None:
        return False
    workflow = _load_workflow_json(workflow_id)
    for model in _extract_workflow_models(workflow):
        if model["key"] == model_key:
            return bool(model["gated"])
    return False


def get_workflow_download_specs(workflow_id: str, model_key: str) -> list[DownloadFileSpec]:
    if COMFYUI_INSTALL_DIR is None:
        raise ValueError("ComfyUI model downloads are not configured")

    workflow = _load_workflow_json(workflow_id)
    for model in _extract_workflow_models(workflow):
        if model["key"] != model_key:
            continue

        dest_path = COMFYUI_INSTALL_DIR / "models" / model["directory"] / model["filename"]
        return [
            DownloadFileSpec(
                url=model["url"],
                dest_path=str(dest_path),
                filename=model["filename"],
            )
        ]

    raise ValueError(f"Unknown workflow model key: {model_key}")
