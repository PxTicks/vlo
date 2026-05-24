#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLATFORM="$(uname -s)"
ARCH="$(uname -m)"
UV_BIN=""
NODE_CMD=""
NODE_DIR=""
NODE_SOURCE=""
NODE_VERSION=""
NPM_CMD=""
NPM_VERSION=""
FORCE_INSTALL_VLO_NODE=0
PYTHON_CMD=""
PYTHON_SOURCE=""
PY_VERSION=""
VLO_NODE_VERSION="22.22.1"
VLO_PYTHON_VERSION="3.13.12"

if [ "$PLATFORM" = "Darwin" ]; then
    VLO_HOME="${HOME}/Library/Application Support/VLO"
else
    VLO_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/VLO"
fi

VLO_NODE_DOWNLOAD_DIR="${TMPDIR:-/tmp}/vlo-installer"
VLO_NODE_ARCH=""
VLO_NODE_BASENAME=""
VLO_NODE_HOME=""
VLO_NODE_EXTRACT_DIR=""
VLO_NODE_EXE=""
VLO_NODE_ARCHIVE_NAME=""
VLO_NODE_ARCHIVE_PATH=""
VLO_NODE_URL=""
VLO_PYTHON_INSTALL_DIR="${VLO_HOME}/python"

info()  { printf '\033[1;34m[INFO]\033[0m  %s\n' "$*"; }
warn()  { printf '\033[1;33m[WARN]\033[0m  %s\n' "$*"; }
error() { printf '\033[1;31m[ERROR]\033[0m %s\n' "$*"; }

while [ $# -gt 0 ]; do
    case "$1" in
        --update-node) FORCE_INSTALL_VLO_NODE=1 ;;
    esac
    shift
done

configure_vlo_node_distribution() {
    case "$PLATFORM" in
        Linux) ;;
        Darwin) ;;
        *)
            error "Managed Node.js install is only supported on Linux and macOS."
            exit 1
            ;;
    esac

    case "$ARCH" in
        x86_64|amd64) VLO_NODE_ARCH="x64" ;;
        aarch64|arm64) VLO_NODE_ARCH="arm64" ;;
        *)
            error "Managed Node.js install is not supported on architecture: $ARCH"
            exit 1
            ;;
    esac

    if [ "$PLATFORM" = "Darwin" ]; then
        VLO_NODE_BASENAME="node-v${VLO_NODE_VERSION}-darwin-${VLO_NODE_ARCH}"
        VLO_NODE_ARCHIVE_NAME="${VLO_NODE_BASENAME}.tar.gz"
    else
        VLO_NODE_BASENAME="node-v${VLO_NODE_VERSION}-linux-${VLO_NODE_ARCH}"
        VLO_NODE_ARCHIVE_NAME="${VLO_NODE_BASENAME}.tar.xz"
    fi

    VLO_NODE_HOME="${VLO_HOME}/${VLO_NODE_BASENAME}"
    VLO_NODE_EXTRACT_DIR="${VLO_HOME}"
    VLO_NODE_EXE="${VLO_NODE_HOME}/bin/node"
    VLO_NODE_ARCHIVE_PATH="${VLO_NODE_DOWNLOAD_DIR}/${VLO_NODE_ARCHIVE_NAME}"
    VLO_NODE_URL="https://nodejs.org/dist/v${VLO_NODE_VERSION}/${VLO_NODE_ARCHIVE_NAME}"
}

version_is_supported_node() {
    local version="$1"
    local major minor

    major="${version%%.*}"
    minor="$(printf '%s' "$version" | cut -d. -f2)"

    if [ "$major" -lt 20 ]; then
        return 1
    fi
    if [ "$major" -eq 20 ] && [ "$minor" -lt 19 ]; then
        return 1
    fi
    if [ "$major" -eq 21 ]; then
        return 1
    fi
    if [ "$major" -eq 22 ] && [ "$minor" -lt 13 ]; then
        return 1
    fi
    return 0
}

try_node_path() {
    local candidate_node="$1"
    local candidate_source="$2"
    local candidate_dir candidate_npm candidate_version

    [ -x "$candidate_node" ] || return 1

    candidate_dir="$(dirname "$candidate_node")"
    candidate_npm="${candidate_dir}/npm"
    [ -x "$candidate_npm" ] || return 1

    candidate_version="$("$candidate_node" -v 2>/dev/null | sed 's/^v//')"
    [ -n "$candidate_version" ] || return 1
    version_is_supported_node "$candidate_version" || return 1

    NODE_CMD="$candidate_node"
    NODE_DIR="$candidate_dir"
    NODE_VERSION="v${candidate_version}"
    NPM_CMD="$candidate_npm"
    NPM_VERSION="$("$candidate_npm" -v 2>/dev/null)"
    NODE_SOURCE="${candidate_source} (${candidate_node})"
    return 0
}

prompt_existing_node_choice() {
    local answer

    info "Detected compatible Node.js ${NODE_VERSION}."
    info "Source: ${NODE_SOURCE}"
    info "VLO can also install its own managed Node.js ${VLO_NODE_VERSION}."
    info "This is useful if you want VLO to avoid your existing global Node.js setup."
    printf '\n'
    read -r -p "Install or update VLO-managed Node.js ${VLO_NODE_VERSION} instead? [y/N]: " answer

    case "${answer}" in
        y|Y|yes|YES)
            install_vlo_node
            ;;
    esac
}

prompt_install_vlo_node() {
    local answer

    warn "No compatible Node.js runtime was found."
    info "VLO can download Node.js ${VLO_NODE_VERSION} into:"
    info "  ${VLO_NODE_HOME}"
    info "This install is per-user and VLO-managed."
    info "It will not modify your system PATH."
    printf '\n'
    read -r -p "Install VLO-managed Node.js ${VLO_NODE_VERSION} now? [Y/n]: " answer

    case "${answer}" in
        n|N|no|NO)
            error "Node.js 20.19+ or 22.13+ is required but was not installed."
            exit 1
            ;;
        *)
            install_vlo_node
            ;;
    esac
}

install_vlo_node() {
    mkdir -p "$VLO_NODE_DOWNLOAD_DIR" "$VLO_HOME"

    info "Downloading Node.js ${VLO_NODE_VERSION} from nodejs.org..."
    curl -fL "$VLO_NODE_URL" -o "$VLO_NODE_ARCHIVE_PATH"

    info "Extracting VLO-managed Node.js ${VLO_NODE_VERSION}..."
    rm -rf "$VLO_NODE_HOME"
    tar -xf "$VLO_NODE_ARCHIVE_PATH" -C "$VLO_NODE_EXTRACT_DIR"

    if ! try_node_path "$VLO_NODE_EXE" "VLO-managed Node.js"; then
        error "Node.js ${VLO_NODE_VERSION} was extracted, but VLO could not find a usable node binary."
        exit 1
    fi

    info "Installed VLO-managed Node.js ${NODE_VERSION}."
}

install_uv_if_needed() {
    UV_BIN="$(command -v uv || true)"
    if [ -z "$UV_BIN" ]; then
        info "Installing uv..."
        curl -LsSf https://astral.sh/uv/install.sh | env UV_NO_MODIFY_PATH=1 sh
        UV_BIN="$HOME/.local/bin/uv"
    fi
    if [ ! -x "$UV_BIN" ]; then
        UV_BIN="$(command -v uv || true)"
    fi
    if [ -z "$UV_BIN" ] || [ ! -x "$UV_BIN" ]; then
        error "uv was not found after installation."
        exit 1
    fi
    info "$("$UV_BIN" --version) found at $UV_BIN"
}

try_python_path() {
    local candidate_python="$1"
    local candidate_source="$2"

    [ -x "$candidate_python" ] || return 1
    if ! "$candidate_python" -c "import sys; raise SystemExit(0 if sys.version_info[:2] >= (3, 10) else 1)" \
        >/dev/null 2>&1; then
        return 1
    fi

    PYTHON_CMD="$candidate_python"
    PYTHON_SOURCE="${candidate_source} (${candidate_python})"
    PY_VERSION="$("$candidate_python" --version 2>&1 | awk '{print $2}')"
    return 0
}

find_vlo_python() {
    UV_PYTHON_INSTALL_DIR="$VLO_PYTHON_INSTALL_DIR" "$UV_BIN" python find "$VLO_PYTHON_VERSION" 2>/dev/null || true
}

prompt_install_vlo_python() {
    local answer

    warn "No compatible Python 3.10+ runtime was found."
    info "VLO can install Python ${VLO_PYTHON_VERSION} into:"
    info "  ${VLO_PYTHON_INSTALL_DIR}"
    info "This install is per-user and VLO-managed."
    info "It will not modify your shell profile."
    printf '\n'
    read -r -p "Install VLO-managed Python ${VLO_PYTHON_VERSION} now? [Y/n]: " answer

    case "${answer}" in
        n|N|no|NO)
            error "Python 3.10+ is required but was not installed."
            exit 1
            ;;
        *)
            install_vlo_python
            ;;
    esac
}

install_vlo_python() {
    local managed_python

    mkdir -p "$VLO_PYTHON_INSTALL_DIR"
    info "Installing VLO-managed Python ${VLO_PYTHON_VERSION} via uv..."
    UV_PYTHON_INSTALL_DIR="$VLO_PYTHON_INSTALL_DIR" "$UV_BIN" python install "$VLO_PYTHON_VERSION"

    managed_python="$(find_vlo_python)"
    if ! try_python_path "$managed_python" "VLO-managed Python"; then
        error "Python ${VLO_PYTHON_VERSION} was installed, but VLO could not find a usable interpreter."
        exit 1
    fi

    info "Installed VLO-managed Python ${PY_VERSION}."
}

# -- 1. Check prerequisites ------------------------------------------

info "VLO Installer"
printf '\n'

configure_vlo_node_distribution
if [ "$FORCE_INSTALL_VLO_NODE" -eq 1 ]; then
    info "--update-node requested. Installing VLO-managed Node.js ${VLO_NODE_VERSION}..."
    install_vlo_node
elif try_node_path "$VLO_NODE_EXE" "VLO-managed Node.js"; then
    prompt_existing_node_choice
else
    while IFS= read -r candidate_node; do
        if try_node_path "$candidate_node" "node"; then
            prompt_existing_node_choice
            break
        fi
    done < <(type -aP node 2>/dev/null || true)
fi

if [ -z "$NODE_CMD" ]; then
    prompt_install_vlo_node
fi

export PATH="${NODE_DIR}:${PATH}"
info "Node.js ${NODE_VERSION} found via ${NODE_SOURCE}"
info "npm ${NPM_VERSION} found via ${NPM_CMD}"

install_uv_if_needed

if try_python_path "$(find_vlo_python)" "VLO-managed Python"; then
    :
else
    for cmd in python3 python; do
        candidate_python="$(command -v "$cmd" || true)"
        if [ -n "$candidate_python" ] && try_python_path "$candidate_python" "$cmd"; then
            break
        fi
    done
fi

if [ -z "$PYTHON_CMD" ]; then
    prompt_install_vlo_python
fi

info "Python ${PY_VERSION} found via ${PYTHON_SOURCE}"

# -- 2. Install frontend dependencies --------------------------------

info "Installing npm dependencies..."
cd "$SCRIPT_DIR"
"$NPM_CMD" install
"$NPM_CMD" install --prefix frontend

# -- 3. Build frontend ------------------------------------------------

info "Building frontend..."
"$NPM_CMD" run build --prefix frontend

# -- 4. Install backend dependencies ---------------------------------

info "Installing backend Python dependencies..."
cd "$SCRIPT_DIR/backend"
"$UV_BIN" sync --frozen --python "$PYTHON_CMD"

# -- 5. Environment config -------------------------------------------

if [ ! -f "$SCRIPT_DIR/backend/.env" ]; then
    cp "$SCRIPT_DIR/backend/.env.example" "$SCRIPT_DIR/backend/.env"
    info "Created backend/.env from .env.example"
else
    info "backend/.env already exists, skipping"
fi

# -- 6. Install SAM2 (Optional) --------------------------------------

printf '\n'
read -r -p "Would you like to install SAM2 for video segmentation and masking? (Requires CUDA for GPU acceleration) [y/N]: " install_sam2

case "${install_sam2}" in
    y|Y|yes|YES)
        info "Installing SAM2..."
        # The backend venv is created by `uv sync` and does NOT contain pip, so
        # install through `uv pip` targeting that venv rather than `python -m pip`.
        VENV_PY="$SCRIPT_DIR/backend/.venv/bin/python"

        # 1. Install CUDA-enabled Torch if requested
        read -r -p "Would you like to install PyTorch with CUDA 12.8 support? (Highly recommended for SAM2 on Nvidia GPUs) [Y/n]: " install_cuda_torch
        case "${install_cuda_torch}" in
            n|N|no|NO)
                info "Skipping CUDA PyTorch installation, using existing PyTorch."
                ;;
            *)
                info "Installing CUDA PyTorch..."
                if ! "$UV_BIN" pip install --python "$VENV_PY" torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu128; then
                    warn "CUDA PyTorch installation failed. Attempting to proceed anyway..."
                fi
                ;;
        esac

        # 2. Clone and install SAM2 (guard each step so a failure does not abort the installer)
        sam2_ready=1
        if ! command -v git >/dev/null 2>&1; then
            warn "git was not found; cannot clone SAM2. Skipping SAM2 install."
            sam2_ready=0
        elif [ ! -d "$SCRIPT_DIR/backend/sam2" ]; then
            info "Cloning facebookresearch/sam2..."
            if ! git clone https://github.com/facebookresearch/sam2.git "$SCRIPT_DIR/backend/sam2"; then
                warn "Failed to clone SAM2 repository. Skipping SAM2 install."
                sam2_ready=0
            fi
        else
            info "sam2 directory already exists, skipping clone."
        fi

        if [ "$sam2_ready" -eq 1 ]; then
            info "Installing SAM2 into the backend virtual environment..."
            if ! "$UV_BIN" pip install --python "$VENV_PY" -e "$SCRIPT_DIR/backend/sam2"; then
                warn "SAM2 installation failed."
            fi
        fi
        ;;
    *)
        info "Skipping SAM2 installation. You can install it manually later if needed."
        ;;
esac

# -- 7. Projects & Models directories ---------------------------------

mkdir -p "$SCRIPT_DIR/projects"
mkdir -p "$SCRIPT_DIR/backend/assets/models/sams"

# -- Done ------------------------------------------------------------

printf '\n'
info "Installation complete!"
info "Run ./run.sh to start VLO"
info "Make sure ComfyUI is running separately (default: http://127.0.0.1:8188)"
