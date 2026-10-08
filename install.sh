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

usage() {
    cat <<'USAGE'
Usage: ./install.sh [options]

  --update-node          Reinstall the vlo-managed Node.js runtime.
  --profiles <list>      Install these optional capability profiles without
                         prompting. Comma-separated; one or more of:
                             sam2, sam-audio, local-ai, all, none
  --no-optional          Install nothing optional. Same as --profiles none.
  --cuda-torch           Install CUDA-enabled PyTorch without prompting.
  --no-cuda-torch        Keep the existing PyTorch build.
  -y, --yes              Accept the default answer to every prompt.
  -h, --help             Show this message.

With --profiles, --no-optional, or a non-interactive stdin, the installer never
prompts, so it can run from CI or a provisioning script. Whatever it was asked
for is recorded in backend/runtime/install-profiles.json, which is how the app
later tells "never installed" apart from "asked for, and the install failed".
USAGE
}

# Profile selection. Empty PROFILES_REQUESTED plus PROFILES_EXPLICIT=0 means
# "ask"; PROFILES_EXPLICIT=1 means the caller has already decided.
PROFILES_REQUESTED=""
PROFILES_EXPLICIT=0
ASSUME_YES=0
CUDA_TORCH_CHOICE=""
HAD_CUDA_TORCH=0
TORCH_CUDA_INDEX_URL="${VLO_TORCH_CUDA_INDEX_URL:-https://download.pytorch.org/whl/cu130}"
INTERACTIVE=1

add_profile() {
    local name="$1"

    case "$name" in
        all|local-ai) add_profile sam2; add_profile sam-audio; return ;;
        none|"") return ;;
        sam2|sam-audio) ;;
        *)
            error "Unknown profile: ${name}"
            usage
            exit 1
            ;;
    esac

    case ",${PROFILES_REQUESTED}," in
        *",${name},"*) return ;;
    esac
    PROFILES_REQUESTED="${PROFILES_REQUESTED:+${PROFILES_REQUESTED},}${name}"
}

profile_requested() {
    case ",${PROFILES_REQUESTED}," in
        *",$1,"*) return 0 ;;
    esac
    return 1
}

while [ $# -gt 0 ]; do
    case "$1" in
        --update-node) FORCE_INSTALL_VLO_NODE=1 ;;
        --profiles)
            shift
            [ $# -gt 0 ] || { error "--profiles needs a value"; exit 1; }
            PROFILES_EXPLICIT=1
            IFS=',' read -r -a _requested_profiles <<< "$1"
            for _profile in "${_requested_profiles[@]}"; do
                add_profile "$(printf '%s' "$_profile" | tr -d '[:space:]')"
            done
            ;;
        --profiles=*)
            PROFILES_EXPLICIT=1
            IFS=',' read -r -a _requested_profiles <<< "${1#*=}"
            for _profile in "${_requested_profiles[@]}"; do
                add_profile "$(printf '%s' "$_profile" | tr -d '[:space:]')"
            done
            ;;
        --no-optional) PROFILES_EXPLICIT=1 ;;
        --cuda-torch) CUDA_TORCH_CHOICE=yes ;;
        --no-cuda-torch) CUDA_TORCH_CHOICE=no ;;
        -y|--yes) ASSUME_YES=1 ;;
        -h|--help) usage; exit 0 ;;
        *)
            error "Unknown option: $1"
            usage
            exit 1
            ;;
    esac
    shift
done

if [ "$PROFILES_EXPLICIT" -eq 1 ] || [ ! -t 0 ]; then
    INTERACTIVE=0
fi

# -- Installer profile marker ----------------------------------------
#
# One line per profile, written once at the end. The registry reads this to
# distinguish an optional feature nobody asked for from one that was requested
# and whose install failed — the soft `warn`-and-continue steps below otherwise
# leave no trace once the terminal scrollback is gone.
PROFILE_STATUS_BASE="skipped"
PROFILE_STATUS_SAM2="skipped"
PROFILE_STATUS_SAM_AUDIO="skipped"

record_profile_status() {
    case "$1" in
        base) PROFILE_STATUS_BASE="$2" ;;
        sam2) PROFILE_STATUS_SAM2="$2" ;;
        sam-audio) PROFILE_STATUS_SAM_AUDIO="$2" ;;
    esac
}

write_profile_marker() {
    local marker_dir="$SCRIPT_DIR/backend/runtime"
    local marker="$marker_dir/install-profiles.json"
    local now
    now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

    mkdir -p "$marker_dir"
    cat > "$marker" <<MARKER
{
  "version": 1,
  "recordedAt": "${now}",
  "installer": "install.sh",
  "uv": "${UV_BIN}",
  "python": "${SCRIPT_DIR}/backend/.venv/bin/python",
  "profiles": {
    "base": {
      "status": "${PROFILE_STATUS_BASE}",
      "requested": true,
      "recordedAt": "${now}"
    },
    "sam2": {
      "status": "${PROFILE_STATUS_SAM2}",
      "requested": $(profile_requested sam2 && printf 'true' || printf 'false'),
      "recordedAt": "${now}"
    },
    "sam-audio": {
      "status": "${PROFILE_STATUS_SAM_AUDIO}",
      "requested": $(profile_requested sam-audio && printf 'true' || printf 'false'),
      "recordedAt": "${now}"
    }
  }
}
MARKER
    info "Recorded installed profiles in ${marker}"
}

# Ask a yes/no question, or answer it from the flags when not interactive.
# $1 prompt, $2 default (y|n), $3 variable name to set to yes|no
#
# EVERY prompt in this installer must go through here. A bare `read` would both
# ignore --profiles/--no-optional/-y and, under `set -e`, abort the run outright
# the moment stdin is at EOF — which is exactly how a provisioning script calls
# it. `|| true` covers the same EOF case for an interactive run whose terminal
# goes away mid-question.
ask_yes_no() {
    # Locals are __-prefixed because bash scoping is dynamic: a local named like
    # the caller's output variable (e.g. `answer`) would capture the printf -v
    # below, leaving the caller's variable unset and tripping `set -u`.
    local __prompt="$1" __default="$2" __outvar="$3" __reply=""

    if [ "$INTERACTIVE" -eq 0 ] || [ "$ASSUME_YES" -eq 1 ]; then
        __reply="$__default"
        info "${__prompt}${__reply} (non-interactive)"
    else
        read -r -p "$__prompt" __reply || __reply=""
        __reply="${__reply:-$__default}"
    fi

    case "$__reply" in
        y|Y|yes|YES) printf -v "$__outvar" 'yes' ;;
        *) printf -v "$__outvar" 'no' ;;
    esac
}

# -- Backend environment and CUDA PyTorch ------------------------------

# Run from backend/. --inexact: the optional profiles are installed with
# `uv pip`, outside the lockfile, so an exact sync would uninstall them.
# Rerunning the installer to add one profile must not remove the others.
sync_backend_environment() {
    "$UV_BIN" sync --frozen --inexact --python "$PYTHON_CMD"
}

# Whether the backend venv holds a PyTorch build from the CUDA index. It has
# to be asked before `uv sync`: torch is locked to PyPI, so the sync swaps that
# build out even when inexact, and this is how a rerun knows to put it back.
venv_has_cuda_index_torch() {
    [ -x "$VENV_PY" ] || return 1
    "$VENV_PY" -c 'import importlib.metadata as m, sys; sys.exit(0 if "+cu" in m.version("torch") else 1)' \
        >/dev/null 2>&1
}

# Whether the torch the sync just installed is a CUDA build, from either index.
venv_torch_has_cuda() {
    "$VENV_PY" -c 'import sys, torch; sys.exit(0 if torch.version.cuda else 1)' >/dev/null 2>&1
}

install_cuda_torch() {
    local pins

    # Pinned to the versions `uv sync` just installed from the lockfile, so the
    # CUDA build is the release everything else in the lock was resolved with.
    pins="$("$VENV_PY" -c 'import importlib.metadata as m; print(" ".join(p + "==" + m.version(p).split("+")[0] for p in ("torch", "torchaudio")))')" \
        || return 1

    info "Installing CUDA PyTorch..."
    # --reinstall-package: the CPU build of the same version already satisfies
    # these pins, so without it uv keeps the CPU build and installs nothing.
    # shellcheck disable=SC2086 # $pins is a space-separated requirement list.
    "$UV_BIN" pip install --python "$VENV_PY" --index-url "$TORCH_CUDA_INDEX_URL" \
        --reinstall-package torch --reinstall-package torchaudio --reinstall-package torchvision \
        $pins torchvision
}

# Offered with the profiles that want a GPU, and repeated without asking when
# an earlier run left a CUDA build that the sync has just replaced.
run_cuda_torch_step() {
    if ! profile_requested sam2 && ! profile_requested sam-audio && [ "$HAD_CUDA_TORCH" -eq 0 ]; then
        return 0
    fi

    # PyPI's Linux wheels are already CUDA builds; only a CPU build (PyPI's
    # Windows and macOS wheels) needs replacing. Checked before asking: a PyPI
    # CUDA build has no +cu tag, so no rerun could remember a "yes" to it.
    if venv_torch_has_cuda; then
        info "PyTorch in the backend environment already has CUDA support."
        return 0
    fi

    if [ -z "$CUDA_TORCH_CHOICE" ] && [ "$HAD_CUDA_TORCH" -eq 1 ]; then
        CUDA_TORCH_CHOICE=yes
        info "Restoring the CUDA PyTorch build from an earlier install."
    fi
    if [ -z "$CUDA_TORCH_CHOICE" ]; then
        ask_yes_no "Would you like to install PyTorch with CUDA 13.0 support? (Highly recommended on Nvidia GPUs) [Y/n]: " y CUDA_TORCH_CHOICE
    fi

    if [ "$CUDA_TORCH_CHOICE" = "yes" ]; then
        install_cuda_torch || warn "CUDA PyTorch installation failed. Attempting to proceed anyway..."
    else
        info "Skipping CUDA PyTorch installation, using existing PyTorch."
    fi
}

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
    info "vlo can also install its own managed Node.js ${VLO_NODE_VERSION}."
    info "This is useful if you want vlo to avoid your existing global Node.js setup."
    printf '\n'
    # Defaults to no: an unattended run keeps the compatible Node.js it found.
    ask_yes_no "Install or update vlo-managed Node.js ${VLO_NODE_VERSION} instead? [y/N]: " n answer

    if [ "$answer" = "yes" ]; then
        install_vlo_node
    fi
}

prompt_install_vlo_node() {
    local answer

    warn "No compatible Node.js runtime was found."
    info "vlo can download Node.js ${VLO_NODE_VERSION} into:"
    info "  ${VLO_NODE_HOME}"
    info "This install is per-user and vlo-managed."
    info "It will not modify your system PATH."
    printf '\n'
    # Defaults to yes: there is no usable Node.js, so the only alternative to
    # installing one is failing.
    ask_yes_no "Install vlo-managed Node.js ${VLO_NODE_VERSION} now? [Y/n]: " y answer

    if [ "$answer" != "yes" ]; then
        error "Node.js 20.19+ or 22.13+ is required but was not installed."
        exit 1
    fi
    install_vlo_node
}

install_vlo_node() {
    mkdir -p "$VLO_NODE_DOWNLOAD_DIR" "$VLO_HOME"

    info "Downloading Node.js ${VLO_NODE_VERSION} from nodejs.org..."
    curl -fL "$VLO_NODE_URL" -o "$VLO_NODE_ARCHIVE_PATH"

    info "Extracting vlo-managed Node.js ${VLO_NODE_VERSION}..."
    rm -rf "$VLO_NODE_HOME"
    tar -xf "$VLO_NODE_ARCHIVE_PATH" -C "$VLO_NODE_EXTRACT_DIR"

    if ! try_node_path "$VLO_NODE_EXE" "vlo-managed Node.js"; then
        error "Node.js ${VLO_NODE_VERSION} was extracted, but vlo could not find a usable node binary."
        exit 1
    fi

    info "Installed vlo-managed Node.js ${NODE_VERSION}."
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
    info "vlo can install Python ${VLO_PYTHON_VERSION} into:"
    info "  ${VLO_PYTHON_INSTALL_DIR}"
    info "This install is per-user and vlo-managed."
    info "It will not modify your shell profile."
    printf '\n'
    # Defaults to yes, for the same reason as the Node.js prompt above.
    ask_yes_no "Install vlo-managed Python ${VLO_PYTHON_VERSION} now? [Y/n]: " y answer

    if [ "$answer" != "yes" ]; then
        error "Python 3.10+ is required but was not installed."
        exit 1
    fi
    install_vlo_python
}

install_vlo_python() {
    local managed_python

    mkdir -p "$VLO_PYTHON_INSTALL_DIR"
    info "Installing vlo-managed Python ${VLO_PYTHON_VERSION} via uv..."
    UV_PYTHON_INSTALL_DIR="$VLO_PYTHON_INSTALL_DIR" "$UV_BIN" python install "$VLO_PYTHON_VERSION"

    managed_python="$(find_vlo_python)"
    if ! try_python_path "$managed_python" "vlo-managed Python"; then
        error "Python ${VLO_PYTHON_VERSION} was installed, but vlo could not find a usable interpreter."
        exit 1
    fi

    info "Installed vlo-managed Python ${PY_VERSION}."
}

# -- 1. Check prerequisites ------------------------------------------

info "vlo Installer"
printf '\n'

if ! command -v git >/dev/null 2>&1 || ! git --version >/dev/null 2>&1; then
    error "Git is required to install vlo and its managed runtimes. Install it from https://git-scm.com/downloads, then rerun this script."
    exit 1
fi

configure_vlo_node_distribution
if [ "$FORCE_INSTALL_VLO_NODE" -eq 1 ]; then
    info "--update-node requested. Installing vlo-managed Node.js ${VLO_NODE_VERSION}..."
    install_vlo_node
elif try_node_path "$VLO_NODE_EXE" "vlo-managed Node.js"; then
    # Already the managed runtime at the pinned version: nothing to offer.
    # --update-node still forces a reinstall.
    :
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

if try_python_path "$(find_vlo_python)" "vlo-managed Python"; then
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
# npm ci installs exactly what the committed lockfiles pin, verifies their
# hashes, and fails instead of re-resolving when a lockfile is out of date.
# npm install would update a stale lockfile instead of failing.
"$NPM_CMD" ci
# Run from inside frontend rather than with --prefix, as install.bat does.
(cd "$SCRIPT_DIR/frontend" && "$NPM_CMD" ci)

# -- 3. Build frontend ------------------------------------------------

info "Building frontend..."
"$NPM_CMD" run build --prefix frontend

# -- 4. Install backend dependencies ---------------------------------

info "Installing backend Python dependencies..."

# The backend venv is created by `uv sync` and does NOT contain pip, so every
# optional install goes through `uv pip` targeting that venv rather than
# `python -m pip`.
VENV_PY="$SCRIPT_DIR/backend/.venv/bin/python"

# Checked before the sync, which is about to replace a CUDA build with the
# lockfile's PyPI build.
if venv_has_cuda_index_torch; then
    HAD_CUDA_TORCH=1
fi

cd "$SCRIPT_DIR/backend"
if sync_backend_environment; then
    record_profile_status base installed
else
    record_profile_status base failed
    error "Backend dependency install failed."
    write_profile_marker
    exit 1
fi

# -- 5. Optional capability profiles ---------------------------------

if [ "$PROFILES_EXPLICIT" -eq 0 ]; then
    # Keep what an earlier install chose, so a rerun (and every update) does
    # not ask again with a default of "no". --profiles still decides outright.
    while IFS= read -r previous_profile; do
        case "$previous_profile" in
            sam2|sam-audio)
                add_profile "$previous_profile"
                info "${previous_profile} was chosen in an earlier install; updating it (use --profiles to choose again)."
                ;;
        esac
    done < <("$VENV_PY" "$SCRIPT_DIR/scripts/previous-install-profiles.py" \
        "$SCRIPT_DIR/backend/runtime/install-profiles.json" 2>/dev/null || true)

    if ! profile_requested sam2; then
        printf '\n'
        ask_yes_no "Would you like to install SAM2 for video segmentation and masking? (Requires CUDA for GPU acceleration) [y/N]: " n want_sam2
        [ "$want_sam2" = "yes" ] && add_profile sam2
    fi

    if ! profile_requested sam-audio; then
        ask_yes_no "Would you like to install SAM-Audio for prompted audio separation? (Requires Python 3.11+) [y/N]: " n want_sam_audio
        [ "$want_sam_audio" = "yes" ] && add_profile sam-audio
    fi
fi

install_profile_requirements() {
    local profile="$1" label="$2" requirements="$3" overrides="${4:-}"
    local override_args=()

    # An overrides file *replaces* a dependency's declared constraint instead of
    # intersecting with it, which is the only way to install a profile whose
    # transitive pin is stale (SAM-Audio: dacvae caps protobuf below 3.20).
    # uv splits an --overrides value at spaces even when it is quoted (the flag
    # shares its parser with the space-separated UV_OVERRIDE), so it is passed
    # relative to the repository root, where the subshell below runs uv.
    if [ -n "$overrides" ]; then
        override_args=(--overrides "$overrides")
    fi

    info "Installing ${label} into the backend virtual environment..."
    if (cd "$SCRIPT_DIR" && "$UV_BIN" pip install --python "$VENV_PY" "${override_args[@]}" -r "$SCRIPT_DIR/$requirements"); then
        record_profile_status "$profile" installed
        info "${label} installed."
        return 0
    fi

    # Deliberately not fatal: one optional runtime failing should not cost the
    # user the whole install. The marker is what keeps this visible afterwards.
    record_profile_status "$profile" failed
    warn "${label} installation failed. The app will report it as blocked, with the command to retry."
    return 1
}

run_cuda_torch_step

if profile_requested sam2; then
    if [ -d "$SCRIPT_DIR/backend/sam2" ]; then
        # A checkout from an earlier installer. Install that one rather than
        # fetching a second copy, so an existing setup keeps working.
        info "Installing SAM2 from the existing backend/sam2 checkout..."
        if "$UV_BIN" pip install --python "$VENV_PY" -e "$SCRIPT_DIR/backend/sam2"; then
            record_profile_status sam2 installed
            info "SAM2 installed."
        else
            record_profile_status sam2 failed
            warn "SAM2 installation failed. The app will report it as blocked, with the command to retry."
        fi
    else
        install_profile_requirements sam2 "SAM2" "backend/requirements-sam2.txt" || true
    fi
else
    info "Skipping SAM2 installation. Rerun with --profiles sam2 to add it later."
fi

if profile_requested sam-audio; then
    install_profile_requirements sam-audio "SAM-Audio" \
        "backend/requirements-sam-audio.txt" "backend/overrides-sam-audio.txt" || true
else
    info "Skipping SAM-Audio installation. Rerun with --profiles sam-audio to add it later."
fi

# -- 7. Projects & Models directories ---------------------------------

mkdir -p "$SCRIPT_DIR/projects"
mkdir -p "$SCRIPT_DIR/backend/assets/models/sams"

write_profile_marker

# -- Done ------------------------------------------------------------

printf '\n'
info "Installation complete!"
info "Run ./run.sh to start vlo"
info "Make sure ComfyUI is running separately (default: http://127.0.0.1:8188)"
