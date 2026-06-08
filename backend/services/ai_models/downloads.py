from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from services.download_service import DownloadFileSpec


ModelInfo = dict[str, object]
ListModelsFn = Callable[["DownloadContext"], list[ModelInfo]]
DownloadSpecsFn = Callable[[str, "DownloadContext"], list[DownloadFileSpec]]
IsGatedFn = Callable[[str, "DownloadContext"], bool]
IsEnabledFn = Callable[["DownloadContext"], bool]


@dataclass(frozen=True)
class DownloadContext:
    workflow_id: str | None = None
    hf_token: str | None = None


@dataclass(frozen=True)
class ResolvedDownload:
    label: str
    files: list[DownloadFileSpec]
    auth_token: str | None = None


@dataclass(frozen=True)
class DownloadProvider:
    model_type: str
    response_key: str
    list_models_fn: ListModelsFn
    download_specs_fn: DownloadSpecsFn
    is_gated_fn: IsGatedFn | None = None
    gated_message: str | None = None
    is_enabled_fn: IsEnabledFn | None = None

    def is_enabled(self, context: DownloadContext) -> bool:
        if self.is_enabled_fn is None:
            return True
        return self.is_enabled_fn(context)

    def list_models(self, context: DownloadContext) -> list[ModelInfo]:
        if not self.is_enabled(context):
            return []
        return self.list_models_fn(context)

    def download_specs(
        self,
        model_key: str,
        context: DownloadContext,
    ) -> list[DownloadFileSpec]:
        return self.download_specs_fn(model_key, context)

    def is_gated(self, model_key: str, context: DownloadContext) -> bool:
        if self.is_gated_fn is None:
            return False
        return self.is_gated_fn(model_key, context)

    def resolve_download(
        self,
        model_key: str,
        context: DownloadContext,
    ) -> ResolvedDownload:
        specs = self.download_specs(model_key, context)
        label = self.label_for(model_key, context)
        auth_token: str | None = None

        if self.is_gated(model_key, context):
            token = (context.hf_token or "").strip()
            if not token:
                raise ValueError(
                    self.gated_message
                    or "This model is gated. Provide an access token to download it."
                )
            auth_token = token

        return ResolvedDownload(label=label, files=specs, auth_token=auth_token)

    def label_for(self, model_key: str, context: DownloadContext) -> str:
        for model in self.list_models(context):
            if model.get("key") == model_key:
                label = model.get("label")
                if isinstance(label, str) and label:
                    return label
                break
        return model_key


class DownloadProviderRegistry:
    def __init__(self, providers: list[DownloadProvider]) -> None:
        self._providers = {provider.model_type: provider for provider in providers}

    def get(self, model_type: str) -> DownloadProvider:
        provider = self._providers.get(model_type)
        if provider is None:
            raise ValueError(f"Unknown model type: {model_type}")
        return provider

    def list_models_for(
        self,
        model_type: str,
        context: DownloadContext,
    ) -> list[ModelInfo]:
        return self.get(model_type).list_models(context)

    def resolve_download(
        self,
        model_type: str,
        model_key: str,
        context: DownloadContext,
    ) -> ResolvedDownload:
        return self.get(model_type).resolve_download(model_key, context)

    def annotate_active_jobs(
        self,
        models_by_type: dict[str, list[ModelInfo]],
        context: DownloadContext,
        find_active_jobs_for_paths: Callable[[set[str]], dict[str, str]],
    ) -> None:
        paths_by_model: dict[tuple[str, str], list[str]] = {}
        all_paths: set[str] = set()

        for model_type, models in models_by_type.items():
            provider = self.get(model_type)
            for model in models:
                key = model.get("key")
                if not isinstance(key, str) or not key:
                    continue
                try:
                    specs = provider.download_specs(key, context)
                except ValueError:
                    continue
                paths = [str(Path(spec.dest_path).resolve()) for spec in specs]
                paths_by_model[(model_type, key)] = paths
                all_paths.update(paths)

        active_jobs_by_path = find_active_jobs_for_paths(all_paths)

        for model_type, models in models_by_type.items():
            for model in models:
                key = model.get("key")
                if not isinstance(key, str):
                    continue
                for path in paths_by_model.get((model_type, key), []):
                    job_id = active_jobs_by_path.get(path)
                    if job_id is not None:
                        model["activeJobId"] = job_id
                        break
