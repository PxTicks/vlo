import asyncio
import json

import pytest

from services import menu_layouts
from routers import app_settings


CUSTOMIZATION = {
    "version": 1,
    "customNodes": [
        {
            "id": "favorites",
            "kind": "folder",
            "label": "Favorites",
            "parentId": None,
            "order": 0,
        }
    ],
    "nodeOverrides": [],
    "leafPlacements": [
        {"leafId": "flux.json", "parentId": "favorites", "order": 0}
    ],
}


def test_menu_layouts_persist_independently_and_reset(tmp_path, monkeypatch):
    path = tmp_path / "profile" / "menu_layouts.json"
    monkeypatch.setattr(menu_layouts, "MENU_LAYOUTS_PATH", path)

    first = menu_layouts.put_menu_layout(
        "generation.workflows", CUSTOMIZATION, base_revision=0
    )
    second = menu_layouts.put_menu_layout(
        "effects.library",
        {**CUSTOMIZATION, "leafPlacements": []},
        base_revision=0,
    )

    assert first["revision"] == 1
    assert second["revision"] == 1
    assert menu_layouts.get_menu_layout("generation.workflows") == first
    assert menu_layouts.get_menu_layout("effects.library") == second
    assert json.loads(path.read_text(encoding="utf-8"))["version"] == 1

    assert menu_layouts.delete_menu_layout("generation.workflows") == {
        "revision": 0,
        "customization": None,
    }
    assert menu_layouts.get_menu_layout("generation.workflows")[
        "customization"
    ] is None
    assert menu_layouts.get_menu_layout("effects.library") == second


def test_menu_layouts_reject_stale_revisions(tmp_path, monkeypatch):
    monkeypatch.setattr(
        menu_layouts, "MENU_LAYOUTS_PATH", tmp_path / "menu_layouts.json"
    )
    menu_layouts.put_menu_layout(
        "generation.workflows", CUSTOMIZATION, base_revision=0
    )

    with pytest.raises(menu_layouts.MenuLayoutConflictError):
        menu_layouts.put_menu_layout(
            "generation.workflows", CUSTOMIZATION, base_revision=0
        )


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {**CUSTOMIZATION, "version": 2},
        {**CUSTOMIZATION, "customNodes": [CUSTOMIZATION["customNodes"][0]] * 2},
        {
            **CUSTOMIZATION,
            "leafPlacements": [CUSTOMIZATION["leafPlacements"][0]] * 2,
        },
        {
            **CUSTOMIZATION,
            "customNodes": [
                {
                    "id": "a",
                    "kind": "category",
                    "label": "A",
                    "parentId": "b",
                    "order": 0,
                },
                {
                    "id": "b",
                    "kind": "category",
                    "label": "B",
                    "parentId": "a",
                    "order": 0,
                },
            ],
        },
    ],
)
def test_menu_layouts_validate_payloads(payload):
    with pytest.raises(ValueError):
        menu_layouts.validate_customization(payload)


def test_menu_layouts_write_atomically(tmp_path, monkeypatch):
    path = tmp_path / "menu_layouts.json"
    monkeypatch.setattr(menu_layouts, "MENU_LAYOUTS_PATH", path)
    menu_layouts.put_menu_layout(
        "generation.workflows", CUSTOMIZATION, base_revision=0
    )

    leftovers = list(tmp_path.glob(".menu_layouts.json.*.tmp"))
    assert leftovers == []
    assert menu_layouts.get_menu_layout("generation.workflows")[
        "customization"
    ] == CUSTOMIZATION


class _JsonRequest:
    def __init__(self, payload):
        self.payload = payload

    async def json(self):
        return self.payload


def test_menu_layout_endpoints_report_validation_and_revision_conflicts(
    tmp_path, monkeypatch
):
    async def direct_threadpool(func, *args, **kwargs):
        return func(*args, **kwargs)

    monkeypatch.setattr(app_settings, "run_in_threadpool", direct_threadpool)
    monkeypatch.setattr(
        menu_layouts, "MENU_LAYOUTS_PATH", tmp_path / "menu_layouts.json"
    )

    created = asyncio.run(
        app_settings.put_persisted_menu_layout(
            "generation.workflows",
            _JsonRequest(
                {"baseRevision": 0, "customization": CUSTOMIZATION}
            ),
        )
    )
    assert created["revision"] == 1

    conflict = asyncio.run(
        app_settings.put_persisted_menu_layout(
            "generation.workflows",
            _JsonRequest(
                {"baseRevision": 0, "customization": CUSTOMIZATION}
            ),
        )
    )
    assert conflict.status_code == 409

    invalid = asyncio.run(
        app_settings.put_persisted_menu_layout(
            "bad",
            _JsonRequest(
                {"baseRevision": 0, "customization": CUSTOMIZATION}
            ),
        )
    )
    assert invalid.status_code == 400

    reset = asyncio.run(
        app_settings.delete_persisted_menu_layout("generation.workflows")
    )
    assert reset == {"revision": 0, "customization": None}


def test_unusable_stored_record_does_not_lock_out_saving(tmp_path, monkeypatch):
    path = tmp_path / "menu_layouts.json"
    monkeypatch.setattr(menu_layouts, "MENU_LAYOUTS_PATH", path)

    menu_layouts.put_menu_layout(
        "generation.workflows", CUSTOMIZATION, base_revision=0
    )

    # Corrupt the stored customization while leaving the revision intact.
    store = json.loads(path.read_text(encoding="utf-8"))
    store["menus"]["generation.workflows"]["customization"]["customNodes"] = [
        {"id": "favorites", "kind": "sideways", "label": "", "parentId": None}
    ]
    path.write_text(json.dumps(store), encoding="utf-8")

    # The invalid customization is omitted, but its revision remains usable for
    # recovery and cannot collide with an older client's revision.
    assert menu_layouts.get_menu_layout("generation.workflows") == {
        "revision": 1,
        "customization": None,
    }
    recovered = menu_layouts.put_menu_layout(
        "generation.workflows", CUSTOMIZATION, base_revision=1
    )
    assert recovered["revision"] == 2
    assert menu_layouts.get_menu_layout("generation.workflows")["customization"] == (
        CUSTOMIZATION
    )

    with pytest.raises(menu_layouts.MenuLayoutConflictError):
        menu_layouts.put_menu_layout(
            "generation.workflows", CUSTOMIZATION, base_revision=1
        )
