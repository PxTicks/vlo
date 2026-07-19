"""Synthetic asset-tagging job for the Phase C conformance fixture."""

from __future__ import annotations

from pathlib import PurePosixPath

from services.extensions import (
    BackendExtensionContext,
    BackendExtensionDefinition,
    BackendJobDefinition,
    BackendJobReadiness,
)


def _validate_input(value: object) -> object:
    if not isinstance(value, dict) or value.get("schemaVersion") != 1:
        raise ValueError("tagging input must use schemaVersion 1")
    assets = value.get("assets")
    if not isinstance(assets, list):
        raise ValueError("tagging input requires an assets array")
    normalized: list[dict[str, str]] = []
    for asset in assets:
        if not isinstance(asset, dict):
            raise ValueError("tagging assets must be objects")
        asset_id = asset.get("id")
        name = asset.get("name")
        asset_type = asset.get("type")
        if not all(
            isinstance(item, str) and item
            for item in (asset_id, name, asset_type)
        ):
            raise ValueError("tagging assets require id, name, and type")
        normalized.append({"id": asset_id, "name": name, "type": asset_type})
    return {"schemaVersion": 1, "assets": normalized}


def _validate_result(value: object) -> object:
    if not isinstance(value, dict) or value.get("schemaVersion") != 1:
        raise ValueError("tagging result must use schemaVersion 1")
    tags_by_asset = value.get("tagsByAsset")
    if not isinstance(tags_by_asset, dict):
        raise ValueError("tagging result requires tagsByAsset")
    for tags in tags_by_asset.values():
        if not isinstance(tags, list) or not all(isinstance(tag, str) for tag in tags):
            raise ValueError("tagging result tags must be string arrays")
    return value


def _run_tagging(_context, value: object) -> object:
    assert isinstance(value, dict)
    assets = value["assets"]
    assert isinstance(assets, list)
    tags_by_asset: dict[str, list[str]] = {}
    for asset in assets:
        assert isinstance(asset, dict)
        asset_id = str(asset["id"])
        name = str(asset["name"])
        asset_type = str(asset["type"])
        suffix = PurePosixPath(name).suffix.lower().removeprefix(".")
        tags = [asset_type]
        if suffix and suffix != asset_type:
            tags.append(suffix)
        if "proxy" in name.lower():
            tags.append("proxy")
        tags_by_asset[asset_id] = tags
    return {"schemaVersion": 1, "tagsByAsset": tags_by_asset}


def create_extension(
    context: BackendExtensionContext,
) -> BackendExtensionDefinition:
    context.logger.info("Tagging conformance backend activated.")
    return BackendExtensionDefinition(
        jobs=(
            BackendJobDefinition(
                id="tag-assets",
                label="Tag fixture assets",
                run=_run_tagging,
                validate_input=_validate_input,
                validate_result=_validate_result,
                readiness=lambda: BackendJobReadiness.available(
                    "Synthetic fixture tagger is ready"
                ),
                timeout_seconds=10,
            ),
        )
    )
