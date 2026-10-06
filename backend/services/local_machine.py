"""Local storage and command transport; editor mechanics remain in the native host."""
import os
import time
import uuid
from pathlib import Path
from fastapi import HTTPException

ENABLED = os.environ.get("VLO_LOCAL_MACHINE") == "1"
PROJECT_ROOT = Path(os.environ.get("VLO_PROJECTS_ROOT", "E:/Media/VLO/Project")).resolve()
TEMP_ROOT = Path(os.environ.get("VLO_TEMP_ROOT", "E:/Media/VLO/Temp")).resolve()
REFERENCE_ROOT = Path(os.environ.get("VLO_REFERENCE_ROOT", "E:/Media/Rubyapp/KeyAsset")).resolve()
RUBYAPP_ROOT = Path(os.environ.get("VLO_RUBYAPP_ROOT", "E:/Media/Rubyapp/Project")).resolve()
MACHINE_URL = os.environ.get("VLO_MACHINE_URL", "http://127.0.0.1:5679/api/v1/machine")
ROOTS = {"projects": PROJECT_ROOT, "temp": TEMP_ROOT, "reference": REFERENCE_ROOT, "rubyapp": RUBYAPP_ROOT}

def resolve_path(root: str, relative: str, *, write: bool = False) -> Path:
    if root not in ROOTS or (write and root not in ("projects", "temp")):
        raise HTTPException(403, "Storage root is unavailable or read-only")
    if "\\" in relative or ":" in relative or any(p in {"..", "."} for p in relative.split("/")):
        raise HTTPException(400, "Only contained relative paths are accepted")
    storage_root = ROOTS[root]
    parts = relative.split("/")
    if root == "projects" and len(parts) >= 3 and parts[1:3] == [".vloproject", "temporary"]:
        storage_root = ROOTS["temp"]
        relative = "/".join(["project_temporary", parts[0], *parts[3:]])
    path = (storage_root / relative).resolve()
    if path != storage_root and storage_root not in path.parents:
        raise HTTPException(403, "Path escapes shared storage")
    return path


class EditorTransport:
    """One browser authority; completed commands stay observable, never retried implicitly."""
    def __init__(self):
        self.session = None
        self.seen = 0.0
        self.jobs = {}

    def heartbeat(self, session: str):
        if self.session and self.session != session and time.monotonic() - self.seen < 15:
            raise HTTPException(409, "Another VLO editor owns automation; close the other tab")
        self.session, self.seen = session, time.monotonic()

    def require_session(self, session: str | None = None):
        if not self.session or time.monotonic() - self.seen >= 15:
            raise HTTPException(503, "Open the VLO browser editor before sending commands")
        if session is not None and session != self.session:
            raise HTTPException(409, "Editor session is not the active authority")

    def submit(self, command: str, args: dict):
        self.require_session()
        if sum(j["status"] in {"pending", "running"} for j in self.jobs.values()) >= 32:
            raise HTTPException(429, "Editor command queue is full")
        # Retain bounded results; active commands are never evicted.
        if len(self.jobs) >= 256:
            for key, job in list(self.jobs.items()):
                if job["status"] not in {"pending", "running"}:
                    del self.jobs[key]
                    break
        job = {"id": str(uuid.uuid4()), "command": command, "args": args,
               "session": self.session, "status": "pending", "result": None, "error": None}
        self.jobs[job["id"]] = job
        return job

    def next(self, session: str):
        self.require_session(session)
        for job in self.jobs.values():
            if job["session"] != session and job["status"] in {"pending", "running"}:
                job.update(status="failed", error="Editor disconnected; outcome unknown, inspect state before retrying")
            if job["status"] == "pending" and job["session"] == session:
                job["status"] = "running"
                return job
        return None

    def finish(self, session: str, job_id: str, result, error):
        self.require_session(session)
        job = self.jobs.get(job_id)
        if not job or job["session"] != session or job["status"] != "running":
            raise HTTPException(409, "Command is not running in this editor")
        job.update(status="failed" if error else "succeeded", result=result, error=error)
        return job

editor_transport = EditorTransport()
