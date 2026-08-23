"""Registry of downloadable models.

Maps human-friendly model keys to their download URLs and destination paths.
"""

from __future__ import annotations

import json
import re
from ipaddress import ip_address
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from config import SAM2_SEARCH_PATHS, SAM_AUDIO_SEARCH_PATHS
from services.comfyui.comfyui_client import get_comfyui_url
from services.download_service import DownloadFileSpec
from services.runtime_settings import get_comfyui_install_dir
from services.sam2.sam2_discovery import discover_sam2_models
from services.sam_audio.sam_audio_discovery import discover_sam_audio_models
from services.workflow_modes import WORKFLOWS_DIR, get_packaged_workflows_dir

_HF_RESOLVE = "https://huggingface.co/{repo}/resolve/main/{filename}"
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
_GATED_WORKFLOW_MODEL_REPOS = frozenset({
    "lightricks/ltx-2.5",
})

# Download policy, mirroring ComfyUI's missingModelDownload.ts. Workflow graphs
# are untrusted input — a graph opened in the editor can name any URL — so the
# backend enforces the same allow-list rather than trusting the client.
_ALLOWED_MODEL_SOURCES = (
    "https://civitai.com/",
    "https://civitai.red/",
    "https://huggingface.co/",
    "http://localhost:",
)
# Deliberately narrower than the set of extensions ComfyUI will *scan* for:
# .bin, .onnx and .gguf are recognised as models but are not downloadable.
_ALLOWED_MODEL_SUFFIXES = (".safetensors", ".sft", ".ckpt", ".pth", ".pt")
_WHITELISTED_MODEL_URLS = frozenset({
    "https://huggingface.co/stabilityai/stable-zero123/resolve/main/stable_zero123.ckpt",
    "https://huggingface.co/TencentARC/T2I-Adapter/resolve/main/models/t2iadapter_depth_sd14v1.pth?download=true",
    "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth",
})


def is_downloadable_model_url(url: str, filename: str) -> bool:
    """Whether a workflow-declared model may be fetched by the download service."""
    if url in _WHITELISTED_MODEL_URLS:
        return True
    if not url.startswith(_ALLOWED_MODEL_SOURCES):
        return False
    return filename.endswith(_ALLOWED_MODEL_SUFFIXES)

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

SAM_AUDIO_MODELS: dict[str, dict] = {
    "sam-audio-large-tv": {
        "label": "SAM-Audio Large TV",
        "description": (
            "High-quality text/span/visual audio separation; gated on Hugging Face. "
            "First runtime load may also need authenticated cached dependencies such as "
            "PE-AV, T5, and the SAM-Audio judge model."
        ),
        "repo": "facebook/sam-audio-large-tv",
        "gated": True,
        "gatedRepoUrl": "https://huggingface.co/facebook/sam-audio-large-tv",
        "files": [
            {"filename": "config.json"},
            {"filename": "checkpoint.pt"},
        ],
    },
}


def is_comfyui_local() -> bool:
    """Whether the configured ComfyUI runs on this machine.

    Downloads land in the local install directory, so they are only meaningful
    when that install is the one serving requests. A local install paired with
    a remote ComfyUI URL would fetch models the remote never sees.
    """
    hostname = urlparse(get_comfyui_url()).hostname
    if not hostname:
        return False
    if hostname == "localhost":
        return True
    try:
        return ip_address(hostname).is_loopback
    except ValueError:
        return False


def is_comfyui_model_downloads_enabled() -> bool:
    return get_comfyui_install_dir() is not None and is_comfyui_local()


def _is_safe_workflow_filename(filename: str) -> bool:
    return not (
        ".." in filename
        or "/" in filename
        or "\\" in filename
        or filename.strip() == ""
    )


def _resolve_workflow_path(filename: str) -> Path | None:
    main = WORKFLOWS_DIR / filename
    if main.exists():
        return main
    default = get_packaged_workflows_dir() / filename
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


def _resolve_workflow_graph(
    workflow_id: str | None,
    workflow_graph: dict[str, Any] | None,
) -> dict[str, Any]:
    """A supplied graph is authoritative; otherwise load the workflow by id.

    The graph the client sends is the active editor state — the same graph it
    will dispatch for execution. That may be a workflow opened directly in the
    ComfyUI editor (never written to vlo's workflow directories) or a saved
    workflow edited but not saved back, so the on-disk copy can be stale. Only
    fall back to disk when the caller has no graph to offer.
    """
    if isinstance(workflow_graph, dict):
        return workflow_graph

    if workflow_id:
        return _load_workflow_json(workflow_id)

    raise ValueError("A workflow id or workflow graph is required")


def _iter_workflow_nodes(workflow: dict[str, Any]) -> list[dict[str, Any]]:
    raw_nodes = workflow.get("nodes")
    if not isinstance(raw_nodes, list):
        return [
            node
            for node in workflow.values()
            if isinstance(node, dict)
            and isinstance(node.get("properties"), dict)
        ]

    nodes = [node for node in raw_nodes if isinstance(node, dict)]

    # Subgraph-based workflows (ComfyUI's own templates since frontend 1.16)
    # keep their loader nodes — and thus the model declarations — inside
    # definitions.subgraphs, not the top-level node list.
    pending: list[dict[str, Any]] = [workflow]
    while pending:
        definitions = pending.pop().get("definitions")
        if not isinstance(definitions, dict):
            continue
        subgraphs = definitions.get("subgraphs")
        if not isinstance(subgraphs, list):
            continue
        for subgraph in subgraphs:
            if not isinstance(subgraph, dict):
                continue
            raw_subgraph_nodes = subgraph.get("nodes")
            if isinstance(raw_subgraph_nodes, list):
                nodes.extend(
                    node for node in raw_subgraph_nodes if isinstance(node, dict)
                )
            pending.append(subgraph)

    return nodes


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


def _is_gated_workflow_model_url(url: str) -> bool:
    if _is_gated_flux_url(url):
        return True

    repo_info = _parse_hf_repo(url)
    if repo_info is None:
        return False
    owner, repo_name, _repo_url = repo_info
    return f"{owner}/{repo_name}".lower() in _GATED_WORKFLOW_MODEL_REPOS


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
            if not is_downloadable_model_url(url, filename):
                continue

            key = _build_workflow_model_key(directory, filename)
            gated = _is_gated_workflow_model_url(url)
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


def get_sam_audio_download_specs(model_key: str) -> list[DownloadFileSpec]:
    model = SAM_AUDIO_MODELS.get(model_key)
    if model is None:
        raise ValueError(f"Unknown SAM-Audio model key: {model_key}")

    dest_dir = SAM_AUDIO_SEARCH_PATHS[0] / model_key
    repo = model["repo"]

    return [
        DownloadFileSpec(
            url=_HF_RESOLVE.format(repo=repo, filename=f["filename"]),
            dest_path=str(dest_dir / f["filename"]),
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


def get_available_sam_audio_models() -> list[dict]:
    discovered = discover_sam_audio_models()
    discovered_keys = {m["key"] for m in discovered}

    result = []
    for key, model in SAM_AUDIO_MODELS.items():
        result.append({
            "key": key,
            "label": model["label"],
            "description": model["description"],
            "installed": key in discovered_keys,
            "gated": bool(model.get("gated")),
            "gatedRepoUrl": model.get("gatedRepoUrl"),
        })
    return result


def is_sam_audio_model_gated(model_key: str) -> bool:
    model = SAM_AUDIO_MODELS.get(model_key)
    return bool(model and model.get("gated"))


def get_available_workflow_models(
    workflow_id: str | None,
    workflow_graph: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    if not is_comfyui_model_downloads_enabled():
        return []

    workflow = _resolve_workflow_graph(workflow_id, workflow_graph)
    models = _extract_workflow_models(workflow)

    result: list[dict[str, Any]] = []
    comfyui_install_dir = get_comfyui_install_dir()
    for model in models:
        dest_path = (
            comfyui_install_dir / "models" / model["directory"] / model["filename"]
            if comfyui_install_dir is not None
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


def is_workflow_model_gated(
    workflow_id: str | None,
    model_key: str,
    workflow_graph: dict[str, Any] | None = None,
) -> bool:
    if not is_comfyui_model_downloads_enabled():
        return False
    workflow = _resolve_workflow_graph(workflow_id, workflow_graph)
    for model in _extract_workflow_models(workflow):
        if model["key"] == model_key:
            return bool(model["gated"])
    return False


def get_workflow_download_specs(
    workflow_id: str | None,
    model_key: str,
    workflow_graph: dict[str, Any] | None = None,
) -> list[DownloadFileSpec]:
    comfyui_install_dir = get_comfyui_install_dir()
    if comfyui_install_dir is None:
        raise ValueError("ComfyUI model downloads are not configured")
    if not is_comfyui_local():
        raise ValueError(
            "vlo is connected to a remote ComfyUI at "
            f"{get_comfyui_url()}, so downloading into the local install "
            "directory would not make the model available to it"
        )

    workflow = _resolve_workflow_graph(workflow_id, workflow_graph)
    for model in _extract_workflow_models(workflow):
        if model["key"] != model_key:
            continue

        dest_path = comfyui_install_dir / "models" / model["directory"] / model["filename"]
        return [
            DownloadFileSpec(
                url=model["url"],
                dest_path=str(dest_path),
                filename=model["filename"],
            )
        ]

    raise ValueError(f"Unknown workflow model key: {model_key}")
