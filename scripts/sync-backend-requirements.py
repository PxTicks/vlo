#!/usr/bin/env python3

from __future__ import annotations

import ast
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
PYPROJECT_PATH = REPO_ROOT / "backend" / "pyproject.toml"
REQUIREMENTS_PATH = REPO_ROOT / "backend" / "requirements.txt"
DEV_REQUIREMENTS_PATH = REPO_ROOT / "backend" / "requirements-dev.txt"
TEST_REQUIREMENTS_PATH = REPO_ROOT / "backend" / "requirements-test.txt"
HEADER = (
    "# Generated from backend/pyproject.toml by scripts/sync-backend-requirements.py.\n"
    "# Keep this file in sync with backend/pyproject.toml.\n"
)


def extract_toml_array(text: str, key: str) -> list[str]:
    anchor = f"{key} = ["
    start = text.find(anchor)
    if start == -1:
        raise ValueError(f"Could not find TOML array for {key!r}")

    cursor = start + len(anchor)
    depth = 1

    while cursor < len(text) and depth > 0:
        char = text[cursor]
        if char == "[":
            depth += 1
        elif char == "]":
            depth -= 1
        cursor += 1

    if depth != 0:
        raise ValueError(f"Unterminated TOML array for {key!r}")

    array_literal = "[" + text[start + len(anchor) : cursor - 1] + "]"
    values = ast.literal_eval(array_literal)
    if not isinstance(values, list) or not all(isinstance(value, str) for value in values):
        raise ValueError(f"TOML array for {key!r} did not resolve to a list of strings")
    return values


def write_requirements(path: Path, requirements: list[str]) -> None:
    path.write_text(HEADER + "\n".join(requirements) + "\n", encoding="utf-8")


def main() -> None:
    pyproject_text = PYPROJECT_PATH.read_text(encoding="utf-8")
    default_requirements = extract_toml_array(pyproject_text, "dependencies")
    dev_requirements = extract_toml_array(pyproject_text, "dev")
    # `test-light` lives under [tool.sync-backend-requirements], not
    # [project.optional-dependencies], so it is not an installable extra.
    test_light_requirements = extract_toml_array(pyproject_text, "test-light")

    write_requirements(REQUIREMENTS_PATH, default_requirements)
    write_requirements(DEV_REQUIREMENTS_PATH, ["-r requirements.txt", *dev_requirements])
    # The CI test lane installs this instead of `-r requirements.txt` so it never
    # pulls the torch/ML stack. It deliberately does NOT start with
    # `-r requirements.txt`; it is the lightweight set plus the dev tools.
    write_requirements(TEST_REQUIREMENTS_PATH, [*test_light_requirements, *dev_requirements])


if __name__ == "__main__":
    main()
