import xxhash
import time
import re
import magic  # pip install python-magic
from pathlib import Path
import urllib.parse

import av
from PIL import Image
from fastapi import UploadFile, HTTPException, status
from config import PROJECTS_ROOT
import services.legacy_core.project_service as project_service



# --- Utils ---

def _sanitize_filename(name: str) -> str:
    sanitized = re.sub(r'[<>:"/\\|?*]', '_', name)
    sanitized = sanitized.strip(". ")
    return sanitized or "unnamed_file"

def _get_unique_asset_path(directory: Path, filename: str) -> Path:
    safe_filename = _sanitize_filename(filename)
    target_path = directory / safe_filename

    if not target_path.exists():
        return target_path

    stem = target_path.stem
    suffix = target_path.suffix
    counter = 1

    while target_path.exists():
        target_path = directory / f"{stem} ({counter}){suffix}"
        counter += 1

    return target_path

def _determine_asset_type_from_path(file_path: Path) -> str:
    """Robust check using python-magic on the saved file."""
    try:
        mime_type = magic.from_file(str(file_path), mime=True)
        if mime_type.startswith('video'): return 'video'
        if mime_type.startswith('image'): return 'image'
        if mime_type.startswith('audio'): return 'audio'
        return 'other'
    except Exception:
        return 'unknown'


def determine_asset_type(file_path: Path) -> str:
    """Public wrapper retained for tests and external callers."""
    return _determine_asset_type_from_path(file_path)

def _validate_content_type(content_type: str | None):
    """
    Fast fail check: simple prefix validation on the header.
    Rejects obvious non-media files (PDFs, docs, binaries) immediately.
    """
    # Handle missing header
    if not content_type:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Missing Content-Type header."
        )
    allowed_prefixes = ("video/", "image/", "audio/")
    
    if not content_type.startswith(allowed_prefixes):
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=f"Unsupported file type: '{content_type}'. Please upload a Video, Image, or Audio file."
        )

def _generate_video_thumbnail(video_path: Path, thumb_path: Path) -> bool:
    """
    Extracts a frame using PyAV and saves as JPEG thumbnail.
    Strategy: Try at 1s. If fails, use first frame.
    Returns True if successful.
    """
    try:
        container = av.open(str(video_path))
        stream = container.streams.video[0]

        # Try seeking to 1 second for a non-black frame
        target_ts = int(1 / stream.time_base) if stream.time_base else 0
        frame = None
        try:
            container.seek(target_ts, stream=stream)
            frame = next(container.decode(video=0))
        except Exception:
            # Fallback: reopen and grab first frame
            container.close()
            container = av.open(str(video_path))
            frame = next(container.decode(video=0))

        img = frame.to_image()  # PIL Image
        # Scale to width=320, maintain aspect ratio
        w, h = img.size
        new_w = 320
        new_h = int(h * new_w / w)
        img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)
        img.save(str(thumb_path), "JPEG", quality=95)
        container.close()
        return True
    except Exception as e:
        print(f"Failed to extract thumbnail for {video_path.name}: {e}")
        return False

def _generate_thumbnail(file_path: Path, asset_type: str) -> str | None:
    """
    Generates a thumbnail for image/video assets.
    Returns the relative filename of the thumbnail (e.g., 'image_thumb.jpg').
    """
    thumb_dir = file_path.parent / "thumbnails"
    thumb_dir.mkdir(exist_ok=True)

    thumb_name = f"{file_path.stem}_thumb.jpg"
    thumb_path = thumb_dir / thumb_name
    
    # Target size for images (videos are handled by ffmpeg scaling)
    size = (320, 320)

    try:
        if asset_type == 'image':
            with Image.open(file_path) as img:
                if img.mode in ("RGBA", "P"): 
                    img = img.convert("RGB")
                img.thumbnail(size)
                img.save(thumb_path, "JPEG", quality=80)
                return thumb_name

        elif asset_type == 'video':
            success = _generate_video_thumbnail(file_path, thumb_path)
            return thumb_name if success else None
            
    except Exception as e:
        print(f"Thumbnail generation failed for {file_path}: {e}")
        return None
    
    return None

def _hash_file(path: Path) -> str:
    xxh = xxhash.xxh64()
    with open(path, "rb") as f: 
        while chunk := f.read(1024 * 1024):
            xxh.update(chunk)
    return xxh.hexdigest()

def _get_duration(file_path: Path) -> float | None:
    """
    Uses PyAV to extract duration in seconds.
    """
    try:
        container = av.open(str(file_path))
        if container.duration is not None:
            duration = container.duration / av.time_base
            container.close()
            return float(duration)
        container.close()
        return None
    except Exception as e:
        print(f"Failed to get duration for {file_path.name}: {e}")
        return None
    
def _ingest_file(project_path: Path, file_path: Path) -> dict:
    """
    Takes a file already existing in the assets folder, 
    generates metadata/thumbs, and returns the asset object.
    """
    file_hash = _hash_file(file_path)
    
    asset_type = _determine_asset_type_from_path(file_path)
    
    duration = None
    if asset_type in ['video', 'audio']:
        duration = _get_duration(file_path)

    # Thumbnail 
    thumb_name = f"{file_path.stem}_thumb.jpg"
    thumb_path = file_path.parent / "thumbnails" / thumb_name
    
    if not thumb_path.exists():
        thumb_name = _generate_thumbnail(file_path, asset_type)
    
    # URLs
    folder_name = urllib.parse.quote(project_path.name)
    base_static_url = f"http://localhost:6332/static/{folder_name}/assets"
    src_url = f"{base_static_url}/{file_path.name}"
    thumb_url = f"{base_static_url}/thumbnails/{thumb_name}" if thumb_name else None

    # 5. Construct Object
    return {
        "id": file_hash, 
        "hash": file_hash,
        "name": file_path.name,
        "type": asset_type,
        "src": src_url,
        "thumbnail": thumb_url,
        "duration": duration,
        "created_at": int(file_path.stat().st_ctime * 1000), # Use file creation time
        "size": file_path.stat().st_size
    }

async def process_upload(project_id: str, file: UploadFile):
    """
    Handles web uploads. Saves file -> Ingests -> Updates Registry.
    """
    _validate_content_type(file.content_type)
    project_path = project_service.get_project_path_by_id(project_id)
    assets_path = project_path / "assets"
    assets_path.mkdir(exist_ok=True, parents=True)
    
    # Save File
    safe_filename = file.filename or "unnamed_file"
    dest_path = project_service._get_unique_path(assets_path, safe_filename) # Reuse utility if available or duplicate logic
    # (Note: You might need to expose _get_unique_path from project_service or copy it here)
    if not dest_path.parent.exists(): dest_path.parent.mkdir()
    
    # Write stream
    with open(dest_path, "wb") as buffer:
        while chunk := await file.read(1024 * 1024): 
            buffer.write(chunk)
            
    # Ingest
    asset_data = _ingest_file(project_path, dest_path)
    
    # Persist to JSON
    project_service.register_asset(project_id, asset_data)
    
    return asset_data

def scan_project_assets(project_id: str):
    """
    The 'Rescan' logic.
    1. Checks Disk vs JSON.
    2. Adds missing files to JSON.
    3. Removes JSON entries if file is missing (optional, but good for cleanup).
    """
    project_path = project_service.get_project_path_by_id(project_id)
    assets_dir = project_path / "assets"
    if not assets_dir.exists():
        return []

    # 1. Get current JSON state
    known_assets = project_service.get_project_assets(project_id)
    known_ids = {a["id"] for a in known_assets}
    known_names = {a["name"] for a in known_assets}
    
    discovered_assets = []
    
    # 2. Iterate Disk
    # Exclude the thumbnails folder
    for file_path in assets_dir.iterdir():
        if file_path.is_file() and file_path.name != ".DS_Store":
            
            # Optimization: If name matches a known asset, we *might* skip hashing
            # But strictly, we should hash to be sure. 
            # For this MVP, we will assume if filename is not in known_names, it's new.
            if file_path.name not in known_names:
                print(f"Scanning new file: {file_path.name}")
                new_asset = _ingest_file(project_path, file_path)
                
                # Check if hash existed (renamed file?)
                if new_asset["id"] not in known_ids:
                    project_service.register_asset(project_id, new_asset)
                    discovered_assets.append(new_asset)
    
    # 3. Return full list
    return project_service.get_project_assets(project_id)
