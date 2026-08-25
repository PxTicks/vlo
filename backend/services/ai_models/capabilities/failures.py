"""Failure classification, message sanitisation, and the last-failure store.

One classifier serves both the probe path and (from the rollout's later step)
real load attempts, so a probe and a genuine job failure can never disagree
about what went wrong. Every classification lands on a code from the closed set
in :class:`FailureCode` — an unrecognised failure becomes
``runtime_load_failed`` rather than a new code, which is what lets the frontend
switch stay total.
"""

from __future__ import annotations

import re
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from .contract import FailureCode, FailureRecord, VerificationStage, utc_now


MAX_MESSAGE_LENGTH = 600

#: Failures that will not resolve on their own, so a capability that hit one is
#: reported as blocked until something changes. The rest — an out-of-memory
#: under load, a network blip, and anything we could not classify — are
#: recorded and shown but never used to lock a feature out: refusing the next
#: attempt on evidence that may have been circumstantial is its own false
#: negative.
DURABLE_FAILURE_CODES: frozenset[FailureCode] = frozenset(
    {
        FailureCode.PYTHON_VERSION_UNSUPPORTED,
        FailureCode.PACKAGE_MISSING,
        FailureCode.PACKAGE_IMPORT_FAILED,
        FailureCode.DEPENDENCY_INCOMPATIBLE,
        FailureCode.MODEL_MISSING,
        FailureCode.MODEL_INVALID,
        FailureCode.CONFIG_MISSING,
        FailureCode.DEVICE_UNAVAILABLE,
        FailureCode.CACHE_UNWRITABLE,
        FailureCode.AUTHENTICATION_REQUIRED,
    }
)


def is_durable(code: FailureCode) -> bool:
    return code in DURABLE_FAILURE_CODES


_PROJECT_ROOT = Path(__file__).resolve().parents[4]
_PROJECT_PLACEHOLDER = "\x00project\x00"

_TOKEN_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\bhf_[A-Za-z0-9]{8,}"),
    re.compile(r"\bsk-[A-Za-z0-9_\-]{8,}"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{16,}"),
    re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._\-]{8,}"),
    re.compile(
        r"(?i)\b(token|api[_-]?key|secret|password|authorization)"
        r"(\s*[=:]\s*|\s+is\s+)([\"']?)[^\s\"',]+\3"
    ),
)

_LONG_OPAQUE = re.compile(r"(?<![/\w])(?=[A-Za-z0-9+/=_-]*\d)[A-Za-z0-9+/=_-]{40,}")
_SENSITIVE_QUERY_KEY = re.compile(
    r"(?i)(token|key|secret|password|signature|credential|authorization)"
)
_URL_USERINFO = re.compile(r"(?i)(https?://)[^/@\s]+@")


def sanitize_message(text: str | None) -> str:
    """Strip a message of anything we would not want in a support export.

    Paths under the project root stay readable (they are the useful half of a
    stack-derived message); the home directory and anything token-shaped do
    not.
    """

    if not text:
        return ""

    cleaned = str(text).strip()
    cleaned = _URL_USERINFO.sub(r"\1[redacted]@", cleaned)
    cleaned = cleaned.replace(str(_PROJECT_ROOT), _PROJECT_PLACEHOLDER)

    home = str(Path.home())
    if home and home != "/":
        cleaned = cleaned.replace(home, "~")

    for pattern in _TOKEN_PATTERNS:
        cleaned = pattern.sub(_redact_match, cleaned)
    cleaned = _LONG_OPAQUE.sub("[redacted]", cleaned)

    cleaned = cleaned.replace(_PROJECT_PLACEHOLDER, "<project>")

    if len(cleaned) > MAX_MESSAGE_LENGTH:
        cleaned = cleaned[: MAX_MESSAGE_LENGTH - 1].rstrip() + "…"
    return cleaned


def sanitize_url(raw_url: str | None) -> str:
    """Keep a diagnostic endpoint recognizable without returning credentials."""

    if not raw_url:
        return ""
    try:
        parsed = urlsplit(raw_url)
        if not parsed.scheme or not parsed.netloc:
            return sanitize_message(raw_url)

        hostname = parsed.hostname or ""
        if ":" in hostname and not hostname.startswith("["):
            hostname = f"[{hostname}]"
        try:
            parsed_port = parsed.port
        except ValueError:
            parsed_port = None
        port = f":{parsed_port}" if parsed_port is not None else ""
        userinfo = "[redacted]@" if parsed.username is not None else ""
        netloc = f"{userinfo}{hostname}{port}"

        query = urlencode(
            [
                (
                    key,
                    "[redacted]"
                    if _SENSITIVE_QUERY_KEY.search(key)
                    else sanitize_message(value),
                )
                for key, value in parse_qsl(parsed.query, keep_blank_values=True)
            ]
        )
        fragment = "[redacted]" if parsed.fragment else ""
        return urlunsplit(
            (
                parsed.scheme,
                netloc,
                sanitize_message(parsed.path),
                query,
                fragment,
            )
        )
    except (TypeError, ValueError):
        return sanitize_message(_URL_USERINFO.sub(r"\1[redacted]@", raw_url))


def _redact_match(match: re.Match[str]) -> str:
    groups = match.groups()
    if len(groups) >= 2:
        # Keyword form: keep "token=" and drop only the value.
        return f"{match.group(1)}{match.group(2)}[redacted]"
    return "[redacted]"


@dataclass(frozen=True)
class ClassifiedFailure:
    code: FailureCode
    summary: str
    detail: str | None = None


def _exception_chain(exc: BaseException) -> list[BaseException]:
    chain: list[BaseException] = []
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        chain.append(current)
        current = current.__cause__ or current.__context__
    return chain


def classify_exception(exc: BaseException) -> ClassifiedFailure:
    """Map an arbitrary exception onto the closed failure-code set."""

    chain = _exception_chain(exc)
    text = " ".join(str(item) for item in chain)
    lowered = text.lower()
    detail = sanitize_message(str(exc))

    if isinstance(exc, MemoryError) or "out of memory" in lowered:
        return ClassifiedFailure(
            FailureCode.OUT_OF_MEMORY,
            "Ran out of memory while loading the model",
            detail,
        )

    for item in chain:
        if isinstance(item, ModuleNotFoundError):
            missing = getattr(item, "name", None)
            summary = (
                f"The {missing} package is not installed"
                if missing
                else "A required Python package is not installed"
            )
            return ClassifiedFailure(FailureCode.PACKAGE_MISSING, summary, detail)
        if isinstance(item, ImportError):
            return ClassifiedFailure(
                FailureCode.PACKAGE_IMPORT_FAILED,
                "A required Python package failed to import",
                detail,
            )

    for item in chain:
        if isinstance(item, PermissionError):
            return ClassifiedFailure(
                FailureCode.CACHE_UNWRITABLE,
                "A required directory is not writable",
                detail,
            )
        if isinstance(item, FileNotFoundError):
            return ClassifiedFailure(
                FailureCode.MODEL_MISSING,
                "A required model file is missing",
                detail,
            )

    if any(
        marker in lowered
        for marker in ("401", "403", "unauthorized", "authentication", "gated repo")
    ):
        return ClassifiedFailure(
            FailureCode.AUTHENTICATION_REQUIRED,
            "The model source requires authentication",
            detail,
        )

    if "cuda" in lowered and any(
        marker in lowered
        for marker in ("is_available() is false", "not available", "no cuda", "no gpu")
    ):
        return ClassifiedFailure(
            FailureCode.DEVICE_UNAVAILABLE,
            "The requested compute device is not available",
            detail,
        )

    if any(
        marker in lowered
        for marker in (
            "undefined symbol",
            "version mismatch",
            "incompatible",
            "but you have",
            "requires a different",
        )
    ):
        return ClassifiedFailure(
            FailureCode.DEPENDENCY_INCOMPATIBLE,
            "An installed dependency is incompatible with this environment",
            detail,
        )

    if any(
        marker in lowered
        for marker in (
            "connection",
            "failed to download",
            "temporary failure in name resolution",
            "timed out",
        )
    ):
        return ClassifiedFailure(
            FailureCode.DEPENDENCY_DOWNLOAD_FAILED,
            "A required download could not be completed",
            detail,
        )

    return ClassifiedFailure(
        FailureCode.RUNTIME_LOAD_FAILED,
        "The runtime failed to load",
        detail,
    )


class FailureStore:
    """In-process record of the last real failure per capability."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._records: dict[str, FailureRecord] = {}

    def record(
        self,
        capability_id: str,
        *,
        code: FailureCode,
        summary: str,
        stage: VerificationStage,
        detail: str | None = None,
    ) -> FailureRecord:
        record = FailureRecord(
            code=code,
            summary=summary,
            stage=stage,
            occurred_at=utc_now(),
            detail=sanitize_message(detail) or None,
        )
        with self._lock:
            self._records[capability_id] = record
        return record

    def record_exception(
        self,
        capability_id: str,
        exc: BaseException,
        *,
        stage: VerificationStage = VerificationStage.LOADED,
    ) -> FailureRecord:
        classified = classify_exception(exc)
        return self.record(
            capability_id,
            code=classified.code,
            summary=classified.summary,
            stage=stage,
            detail=classified.detail,
        )

    def get(self, capability_id: str) -> FailureRecord | None:
        with self._lock:
            return self._records.get(capability_id)

    def clear(self, capability_id: str | None = None) -> None:
        with self._lock:
            if capability_id is None:
                self._records.clear()
            else:
                self._records.pop(capability_id, None)


_STORE = FailureStore()


def record_failure(
    capability_id: str,
    *,
    code: FailureCode,
    summary: str,
    stage: VerificationStage,
    detail: str | None = None,
) -> FailureRecord:
    return _STORE.record(
        capability_id, code=code, summary=summary, stage=stage, detail=detail
    )


def record_exception(
    capability_id: str,
    exc: BaseException,
    *,
    stage: VerificationStage = VerificationStage.LOADED,
) -> FailureRecord:
    return _STORE.record_exception(capability_id, exc, stage=stage)


def get_last_failure(capability_id: str) -> FailureRecord | None:
    return _STORE.get(capability_id)


def clear_failures(capability_id: str | None = None) -> None:
    _STORE.clear(capability_id)


@contextmanager
def record_load_failures(
    capability_id: str,
    *,
    stage: VerificationStage = VerificationStage.LOADED,
    ignore: tuple[type[BaseException], ...] = (),
) -> Iterator[None]:
    """Classify and record whatever a real runtime load raises, then re-raise.

    This is the other half of the probe path: the same classifier runs over a
    genuine failure, so a probe and a real job can never disagree about what
    went wrong. The exception is never swallowed — the caller still fails as it
    would have.

    Cancellation is not failure, so ``ignore`` (plus the interpreter's own
    control-flow exceptions) passes straight through unrecorded.
    """

    # A genuine attempt is newer evidence than the cached import probe. Drop
    # that capability's probe before loading so a fixed environment cannot
    # remain blocked by the old answer. Do not clear the failure record here:
    # it is replaced on failure and cleared only once the load succeeds.
    from .subprocess_probe import invalidate_probe_cache

    invalidate_probe_cache(capability_id)
    try:
        yield
    except (KeyboardInterrupt, SystemExit):
        raise
    except ignore:
        raise
    except Exception as exc:
        record_exception(capability_id, exc, stage=stage)
        raise


def note_capability_success(
    capability_id: str,
    *,
    resolved_device: str | None = None,
    detail: str | None = None,
) -> None:
    """Forget a recorded failure because the runtime just loaded.

    A successful load is the strongest evidence available, and it outranks
    anything an earlier attempt observed.
    """

    from .observations import note_load_success

    clear_failures(capability_id)
    note_load_success(
        capability_id,
        resolved_device=resolved_device,
        detail=detail,
    )
