import os
import sys

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services.workflow_rules.node_discovery import has_any_input, resolve_node_policy
from services.workflow_rules.node_parsing import build_input_node_map


def test_vlo_memory_load_audio_remains_discoverable_without_audio_upload_flag():
    class_info = {
        "input": {
            "required": {
                "audio": [
                    ["example.wav"],
                    {
                        "remote": {
                            "route": "/api/vlo-memory/options?kind=audio",
                            "refresh_button": True,
                        }
                    },
                ]
            }
        }
    }

    policy = resolve_node_policy("VLOMemoryLoadAudio", class_info)

    assert policy["has_audio_input"] is True
    assert has_any_input(policy) is True
    node_map = build_input_node_map({"VLOMemoryLoadAudio": class_info})

    assert node_map["vloMemoryLoadAudio"] == [
        {
            "input_type": "audio",
            "param": "audio",
            "label": "Audio",
            "description": None,
        }
    ]
    assert node_map["VLOMemoryLoadAudio"] == node_map["vloMemoryLoadAudio"]
