#!/usr/bin/env python3

from __future__ import annotations

import argparse
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path
from typing import Sequence


REPO_ROOT = Path(__file__).resolve().parent.parent
README_PATH = REPO_ROOT / "README.md"
START_MARKER = "<!-- comfyui-custom-nodes:start -->"
END_MARKER = "<!-- comfyui-custom-nodes:end -->"
CUSTOM_NODE_URL_PATTERN = re.compile(r"^- (https://github\.com/\S+)\s*$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Clone VLO's recommended ComfyUI custom nodes into a ComfyUI install "
            "and install each node's requirements.txt with the active Python."
        )
    )
    parser.add_argument(
        "--comfyui-dir",
        type=str,
        help="Path to the ComfyUI install directory. If omitted, you will be prompted.",
    )
    return parser.parse_args()


def clean_path(raw_path: str) -> Path:
    return Path(raw_path.strip().strip('"').strip("'")).expanduser().resolve()


def prompt_for_comfyui_dir(provided_path: str | None) -> Path:
    if provided_path:
        return clean_path(provided_path)

    default_path = os.environ.get("COMFYUI_INSTALL_DIR", "")
    prompt = "ComfyUI install directory"
    if default_path:
        prompt += f" [{default_path}]"
    prompt += ": "

    entered_path = input(prompt).strip()
    if not entered_path and default_path:
        entered_path = default_path
    if not entered_path:
        raise SystemExit("No ComfyUI install directory provided.")

    return clean_path(entered_path)


def resolve_custom_nodes_dir(comfyui_dir: Path) -> Path:
    if not comfyui_dir.exists():
        raise SystemExit(f"ComfyUI install directory does not exist: {comfyui_dir}")
    if not comfyui_dir.is_dir():
        raise SystemExit(f"ComfyUI install path is not a directory: {comfyui_dir}")

    if comfyui_dir.name == "custom_nodes":
        custom_nodes_dir = comfyui_dir
    else:
        custom_nodes_dir = comfyui_dir / "custom_nodes"

    if custom_nodes_dir.exists() and not custom_nodes_dir.is_dir():
        raise SystemExit(f"custom_nodes path exists and is not a directory: {custom_nodes_dir}")
    custom_nodes_dir.mkdir(exist_ok=True)
    return custom_nodes_dir


def read_custom_node_urls(readme_path: Path) -> list[str]:
    readme_text = readme_path.read_text(encoding="utf-8")
    try:
        custom_nodes_block = readme_text.split(START_MARKER, 1)[1].split(END_MARKER, 1)[0]
    except IndexError as exc:
        raise SystemExit(
            f"Could not find the custom node URL list in {readme_path}. "
            "Expected README markers are missing."
        ) from exc

    urls = [
        match.group(1).rstrip("/")
        for line in custom_nodes_block.splitlines()
        if (match := CUSTOM_NODE_URL_PATTERN.match(line.strip()))
    ]
    if not urls:
        raise SystemExit(f"No custom node GitHub URLs were found in {readme_path}.")

    return urls


def repo_dir_name(repo_url: str) -> str:
    repo_name = repo_url.removesuffix(".git").rsplit("/", 1)[-1]
    if not repo_name:
        raise SystemExit(f"Could not determine a directory name for {repo_url}")
    return repo_name


def run_command(args: Sequence[str], cwd: Path | None = None) -> None:
    print(f"$ {shlex.join(args)}")
    try:
        subprocess.run(args, cwd=cwd, check=True)
    except subprocess.CalledProcessError as exc:
        raise SystemExit(f"Command failed with exit code {exc.returncode}: {shlex.join(args)}") from exc


def require_git() -> None:
    try:
        subprocess.run(["git", "--version"], check=True, stdout=subprocess.DEVNULL)
    except FileNotFoundError as exc:
        raise SystemExit("git was not found on PATH. Install git and rerun this script.") from exc
    except subprocess.CalledProcessError as exc:
        raise SystemExit("git was found, but `git --version` failed.") from exc


def clone_missing_nodes(custom_nodes_dir: Path, repo_urls: Sequence[str]) -> None:
    for repo_url in repo_urls:
        node_dir = custom_nodes_dir / repo_dir_name(repo_url)

        if node_dir.exists():
            if not node_dir.is_dir():
                raise SystemExit(f"Cannot clone {repo_url}; target exists and is not a directory: {node_dir}")
            print(f"[skip] {node_dir.name} already exists")
            continue

        print(f"[clone] {repo_url}")
        run_command(["git", "clone", repo_url, str(node_dir)])


def install_requirements(custom_nodes_dir: Path, repo_urls: Sequence[str]) -> None:
    for repo_url in repo_urls:
        node_dir = custom_nodes_dir / repo_dir_name(repo_url)
        requirements_path = node_dir / "requirements.txt"

        if not requirements_path.exists():
            print(f"[skip] {node_dir.name} has no requirements.txt")
            continue

        print(f"[pip] Installing requirements for {node_dir.name}")
        run_command([sys.executable, "-m", "pip", "install", "-r", str(requirements_path)])


def main() -> int:
    args = parse_args()
    comfyui_dir = prompt_for_comfyui_dir(args.comfyui_dir)
    custom_nodes_dir = resolve_custom_nodes_dir(comfyui_dir)
    repo_urls = read_custom_node_urls(README_PATH)

    print(f"Using custom nodes directory: {custom_nodes_dir}")
    print(f"Using Python for requirements: {sys.executable}")

    require_git()
    clone_missing_nodes(custom_nodes_dir, repo_urls)
    install_requirements(custom_nodes_dir, repo_urls)

    print("ComfyUI custom node setup complete.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
