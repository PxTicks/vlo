"""Compatibility exports for the supported extension job artifact surface."""

from services.jobs.artifacts import (
    DEFAULT_MAX_JOB_ARTIFACT_BYTES,
    JobArtifactError as ExtensionJobArtifactError,
    JobArtifactNotFoundError as ExtensionJobArtifactNotFoundError,
    JobArtifactRecord as ExtensionJobArtifactRecord,
    JobArtifactStore as ExtensionJobArtifactStore,
    JobArtifactTooLargeError as ExtensionJobArtifactTooLargeError,
)

__all__ = [
    "DEFAULT_MAX_JOB_ARTIFACT_BYTES",
    "ExtensionJobArtifactError",
    "ExtensionJobArtifactNotFoundError",
    "ExtensionJobArtifactRecord",
    "ExtensionJobArtifactStore",
    "ExtensionJobArtifactTooLargeError",
]
