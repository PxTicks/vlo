 ##DEPRECATED SERVICE



import asyncio
import pytest
import shutil
import os
import magic
import sys
from pathlib import Path
from unittest.mock import MagicMock, AsyncMock
from fastapi import UploadFile
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# Import the code to be tested
# Adjust the import based on your actual folder structure
from services.legacy_core.asset_service import (
    determine_asset_type, 
    _get_unique_asset_path, 
    process_upload,
    _sanitize_filename
)

# --- Fixtures ---

@pytest.fixture
def temp_project_dir(tmp_path):
    """Creates a temporary project directory structure for testing."""
    project_root = tmp_path / "projects"
    project_root.mkdir()
    
    project_id = "test_project_123"
    project_path = project_root / f"Title_{project_id}"
    project_path.mkdir()
    
    assets_path = project_path / "assets"
    assets_path.mkdir()
    
    return project_path, assets_path

@pytest.fixture
def mock_upload_file():
    """Helper to create a mock FastAPI UploadFile."""
    def _create_file(filename, content=b"fake content"):
        file = MagicMock(spec=UploadFile)
        file.filename = filename
        file.read = AsyncMock(side_effect=[content, b""]) # Return content then empty bytes
        return file
    return _create_file

# --- Tests ---

def test_sanitize_filename():
    assert _sanitize_filename("valid_file.jpg") == "valid_file.jpg"
    assert _sanitize_filename("bad/file:name?.png") == "bad_file_name_.png"
    assert _sanitize_filename("..hidden") == "hidden"
    assert _sanitize_filename("") == "unnamed_file"

def test_get_unique_asset_path(temp_project_dir):
    _, assets_path = temp_project_dir
    
    # 1. Test unused name
    path1 = _get_unique_asset_path(assets_path, "image.png")
    assert path1.name == "image.png"
    
    # Create the file to simulate collision
    path1.touch()
    
    # 2. Test collision handling (should be image (1).png)
    path2 = _get_unique_asset_path(assets_path, "image.png")
    assert path2.name == "image (1).png"
    
    # Create that one too
    path2.touch()
    
    # 3. Test secondary collision (should be image (2).png)
    path3 = _get_unique_asset_path(assets_path, "image.png")
    assert path3.name == "image (2).png"

def test_determine_asset_type_with_magic(tmp_path):
    """
    This creates real files with specific headers to fool/test python-magic.
    """
    # Create a fake PNG file (magic number: 89 50 4E 47 0D 0A 1A 0A)
    png_file = tmp_path / "test.png"
    with open(png_file, "wb") as f:
        f.write(b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR')
        
    # Create a fake JPG file (magic number: FF D8 FF)
    jpg_file = tmp_path / "test.jpg"
    with open(jpg_file, "wb") as f:
        f.write(b'\xFF\xD8\xFF\xE0\x00\x10JFIF')
        
    # Create a text file
    txt_file = tmp_path / "test.txt"
    with open(txt_file, "w") as f:
        f.write("Just some plain text")

    assert determine_asset_type(png_file) == "image"
    assert determine_asset_type(jpg_file) == "image"
    
    # If your logic returns 'other' for text
    assert determine_asset_type(txt_file) == "other"

def test_process_upload_flow(temp_project_dir, mock_upload_file, monkeypatch):
    project_path, assets_path = temp_project_dir
    project_id = "test_123"

    # Mock get_project_path_by_id to return our temp dir instead of looking at real config
    monkeypatch.setattr(
        "services.legacy_core.project_service.get_project_path_by_id",
        lambda pid: project_path
    )
    monkeypatch.setattr(
        "services.legacy_core.project_service.register_asset",
        lambda pid, asset: asset,
    )

    # Mock the file upload
    file_content = b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR' 
    mock_file = mock_upload_file("my_upload.png", content=file_content)
    # Run the service method
    result = asyncio.run(process_upload(project_id, mock_file))

    # Assertions
    assert result["name"] == "my_uploadpng"
    assert result["type"] == "image" # Should be detected as image by magic
    assert (assets_path / "my_uploadpng").exists() # File should be on disk
    assert "id" in result
