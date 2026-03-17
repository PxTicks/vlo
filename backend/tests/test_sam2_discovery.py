import os
import sys

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services.sam2.sam2_discovery import discover_sam2_models

def test_discover_sam2_models_finds_models(monkeypatch, tmp_path):
    # Setup dummy paths
    search_path = tmp_path / "sams"
    search_path.mkdir()
    
    model1 = search_path / "sam2.1_hiera_large.pt"
    model1.touch()
    
    model2 = search_path / "custom_model.safetensors"
    model2.touch()
    model2_config = search_path / "custom_model.yaml"
    model2_config.touch()
    
    monkeypatch.setattr("services.sam2.sam2_discovery.SAM2_SEARCH_PATHS", [search_path])
    monkeypatch.setattr("services.sam2.sam2_discovery._find_sam2_package_config_dir", lambda: None)
    
    models = discover_sam2_models()
    assert len(models) == 2
    
    # Sort order is alphabetical by name: 
    assert models[0]["name"] == "custom_model.safetensors"
    assert models[0]["checkpoint_path"] == str(model2)
    assert models[0]["config_path"] == str(model2_config) # Detected the co-located config
    
    assert models[1]["name"] == "sam2.1_hiera_large.pt"
    assert models[1]["checkpoint_path"] == str(model1)
    assert models[1]["config_path"] == "sam2.1_hiera_l.yaml" # Inferred config fallback


def test_discover_sam2_models_finds_inferred_local_21_config(monkeypatch, tmp_path):
    search_path = tmp_path / "sams"
    search_path.mkdir()

    model = search_path / "sam2.1_hiera_small.pt"
    model.touch()
    local_21_config = search_path / "sam2.1_hiera_s.yaml"
    local_21_config.touch()

    monkeypatch.setattr("services.sam2.sam2_discovery.SAM2_SEARCH_PATHS", [search_path])
    monkeypatch.setattr("services.sam2.sam2_discovery._find_sam2_package_config_dir", lambda: None)

    models = discover_sam2_models()
    assert len(models) == 1
    assert models[0]["name"] == "sam2.1_hiera_small.pt"
    assert models[0]["config_path"] == str(local_21_config)
