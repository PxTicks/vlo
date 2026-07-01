from __future__ import annotations

import os
import sys

import pytest

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services.extensions import (
    ExtensionManifest,
    PythonDependency,
    check_python_dependencies,
)
from services.extensions.manifest import ExtensionManifest as ManifestModel

_MISSING_MODULE = "vlo_definitely_absent_dependency"


def _manifest(python_dependencies: list[dict[str, object]]) -> ExtensionManifest:
    return ManifestModel.model_validate(
        {
            "manifestVersion": 1,
            "id": "example.preflight",
            "name": "Preflight Example",
            "version": "1.0.0",
            "sdk": ">=1.0.0 <2.0.0",
            "backend": {
                "mode": "in_process",
                "entry": "backend.extension:create_extension",
            },
            "capabilities": [],
            "pythonDependencies": python_dependencies,
        }
    )


def test_manifest_parses_and_normalizes_python_dependencies():
    manifest = _manifest(
        [
            {
                "module": " torch ",
                "distribution": " torch ",
                "purpose": " GPU inference ",
            },
            {"module": "whisper"},
        ]
    )
    assert [dep.module for dep in manifest.python_dependencies] == [
        "torch",
        "whisper",
    ]
    first = manifest.python_dependencies[0]
    assert first.distribution == "torch"
    assert first.purpose == "GPU inference"
    assert manifest.python_dependencies[1].distribution is None


def test_manifest_rejects_dotted_module_probe():
    with pytest.raises(Exception):
        _manifest([{"module": "google.protobuf"}])


def test_manifest_rejects_duplicate_dependency_module():
    with pytest.raises(Exception):
        _manifest([{"module": "torch"}, {"module": "torch"}])


def test_empty_dependencies_are_satisfied_without_hints():
    report = check_python_dependencies([])
    assert report.satisfied is True
    assert report.dependencies == ()
    assert report.install_hints == ()


def test_present_module_is_satisfied():
    report = check_python_dependencies([PythonDependency(module="json")])
    assert report.satisfied is True
    assert report.dependencies[0].satisfied is True
    assert report.install_hints == ()


def test_report_records_the_live_backend_environment():
    report = check_python_dependencies([])
    assert report.environment == sys.prefix
    assert report.isolated == (sys.prefix != sys.base_prefix)


def test_missing_module_reports_install_hints_with_distribution():
    report = check_python_dependencies(
        [
            PythonDependency(module="json"),
            PythonDependency(
                module=_MISSING_MODULE,
                distribution="vlo-example-dist",
                purpose="Fake dependency",
            ),
        ]
    )
    assert report.satisfied is False
    statuses = {dep.module: dep for dep in report.dependencies}
    assert statuses["json"].satisfied is True
    assert statuses[_MISSING_MODULE].satisfied is False
    # The install hint targets the distribution name, not the import name.
    assert any("vlo-example-dist" in hint for hint in report.install_hints)
    # Both a pip and a uv command are offered, and both reference the live
    # interpreter path rather than a guessed environment location.
    assert any("-m pip install" in hint for hint in report.install_hints)
    assert any("uv pip install --python" in hint for hint in report.install_hints)
    assert all(sys.executable in hint for hint in report.install_hints)


def test_missing_module_without_distribution_hints_by_import_name():
    report = check_python_dependencies([PythonDependency(module=_MISSING_MODULE)])
    assert report.satisfied is False
    assert any(_MISSING_MODULE in hint for hint in report.install_hints)
