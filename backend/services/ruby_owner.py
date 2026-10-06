"""Small boundary onto the installed original Ruby builder, never its runner."""
import hashlib
import importlib
import importlib.util
import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit
from fastapi import HTTPException

OWNER_SOURCE = Path(os.environ.get("VLO_RUBY_SOURCE", "D:/Other-projects/rubyapp-videogenerator/server/app"))
LIBRARY_ROOT = Path(os.environ.get("VLO_RUBY_LIBRARY", "E:/rubyapp/Library"))
RUBY_URL = os.environ.get("VLO_RUBY_URL", "http://127.0.0.1:7010")
MEDIA_ROOTS = [Path(p).resolve() for p in os.environ.get("VLO_SHARED_MEDIA_READ_ROOTS", "E:/Media/VLO;E:/Media/Rubyapp/Project;E:/Media/Rubyapp/KeyAsset;E:/Media/ComfyUI/Project;E:/Media/ComfyUI/Input;E:/Media/ComfyUI/Temp").split(";") if p]

def owner_module(name):
    """Load relative imports under a private name, avoiding VLO package collisions.

    registry/shot/comfy import definitions only: no owner application boot,
    settings, credential files, runner, engine.run or model module is loaded.
    """
    package = "vlo_ruby_owner"
    if package not in sys.modules:
        source = OWNER_SOURCE.resolve()
        if not (source / "registry.py").is_file():
            raise HTTPException(503, "Installed Ruby owner source is unavailable")
        spec = importlib.util.spec_from_file_location(package, source / "__init__.py", submodule_search_locations=[str(source)])
        module = importlib.util.module_from_spec(spec)
        sys.modules[package] = module
        spec.loader.exec_module(module)
    return importlib.import_module(f"{package}.{name}")

def source_card(preset_id, expected_hash):
    if not re.fullmatch(r"[a-zA-Z0-9_-]+", preset_id):
        raise HTTPException(422, "Invalid native preset ID")
    root = (LIBRARY_ROOT / "Preset").resolve()
    path = (root / preset_id / "preset.json").resolve()
    if root not in path.parents:
        raise HTTPException(403, "Preset source escaped the owner Library")
    registry = owner_module("registry")
    try:
        card = registry.load_card(path)
        # Owner catalogue identity hashes card bytes and graph bytes together.
        hashes = [hashlib.sha256(p.read_bytes()).hexdigest() for p in (card.source_path, card.workflow_api)]
        actual = hashlib.sha256(":".join(hashes).encode()).hexdigest()
    except (OSError, RuntimeError, ValueError) as error:
        raise HTTPException(422, f"Original Ruby card refused: {error}") from error
    if actual != expected_hash:
        raise HTTPException(409, "Ruby Library changed while binding; refresh and reimport")
    return card

def media_path(value):
    text = str(value)
    if text.startswith("file:"):
        parsed = urlsplit(text)
        if parsed.netloc not in {"", "localhost"}:
            raise HTTPException(403, "Remote media addresses are unavailable")
        text = unquote(parsed.path).lstrip("/") if re.match(r"^/[A-Za-z]:", parsed.path) else unquote(parsed.path)
    path = Path(text)
    if not path.is_absolute():
        raise HTTPException(422, "Select an existing absolute shared-media path")
    path = path.resolve()
    if not any(root == path or root in path.parents for root in MEDIA_ROOTS):
        raise HTTPException(403, "Source media must stay in the configured shared E media roots")
    if not path.is_file():
        raise HTTPException(422, "Selected source media is missing")
    return path

async def build_bound_graph(card, values, receipt_id):
    """Use original card.build for all pruning, duration and protected-head rules.

    The original native Comfy client copies only selected media into Comfy's
    managed TEMP. It does not submit a prompt or enter a GPU reservation.
    """
    prepared = dict(values)
    files = {slot.name:media_path(prepared[slot.name]) for slot in card.slots if slot.type in owner_module("registry").MEDIA_SLOT_TYPES and prepared.get(slot.name)}
    try:
        card.build(prepared)  # Validate original rules before any media handoff.
        client = owner_module("comfy").ComfyClient("http://127.0.0.1:8188")
        folder = f"vlo/library/{hashlib.sha256(receipt_id.encode()).hexdigest()[:16]}"
        for name, path in files.items():
            payload = path.read_bytes()
            filename = hashlib.sha256(payload).hexdigest() + path.suffix.lower()
            uploaded = await client.upload_image(filename, payload, subfolder=folder, kind="temp")
            prepared[name] = f"{uploaded['subfolder']}/{uploaded['name']} [temp]"
        return card.build(prepared)
    except (OSError, RuntimeError, ValueError) as error:
        raise HTTPException(422, f"Original Ruby bound graph refused: {error}") from error

def graph_hash(graph):
    return hashlib.sha256(json.dumps(graph, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
