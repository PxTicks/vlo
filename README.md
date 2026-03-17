# Vlo

Vlo is a free, local, open source video editor with ComfyUI-backed generative AI features.

It is in early alpha and there will be bugs, but I am choosing to release it because it already makes it possible to do things which can be challenging otherwise.

## IMPORTANT

Vlo requires chromium-based browsers to work. I have tested in edge and chrome, but other chromium browsers (e.g. opera) may also function. The are two fundamental reasons for this limitation.

1. It uses the File System Access API for smooth and efficient file management directly on disk. This allows for a unified file management interface, whether you launch vlo on your own computer or on a remote service (e.g. runpod). You can still access your locally-stored project files. One caveat: it is best to keep your projects in a folder where you can easily find them, as clearing browser data will forget their location.
2. The media renderer is built on mediabunny, which wraps webcodecs. Webcodecs has implementation differences between firefox and chrome, and during early testing, this led to noticeable lag. The Webcodecs API is the basis of frame-accurate web video, and is indispensable for a project like this.

## Features

- SAM2 points editor and masking.
  - Includes automatic cropping and stitching for video inpainting workflows.
- ComfyUI bridge, allowing images, videos and timeline selections to be sent to ComfyUI
  - Includes automatic aspect ratio adjustment (video models such as WAN and LTX2.3 cannot do all aspect ratios exactly).
- Built in stackable adjustments and filters
- Keyframes and spline editor for all transformations (layout, adjustments and filter effects)

## Install

If the idea of the command line makes you uncomfortable, you can skip to the [one-click install](#one-click-setup) section, although you still do need to the command line for SAM2 if you want segmentation (for the moment).

### Manual Setup

It is recommended to set up a Python virtual environment (`venv`) before installing dependencies and to run all commands within that environment. Use Python 3.10 or newer.

Linux / macOS:

```bash
git clone https://github.com/PxTicks/vlo
cd vlo

# Frontend
npm install
npm install --prefix frontend

# Backend venv (recommended)
python -m venv backend/.venv
source backend/.venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r backend/requirements.txt #or requirements-dev.txt to include tests

cp backend/.env.example backend/.env  # then edit as needed
```

Windows (PowerShell):

```powershell
git clone https://github.com/PxTicks/vlo
Set-Location vlo

# Frontend
npm install
npm install --prefix frontend

# Backend venv (recommended)
python -m venv backend/.venv
backend\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r backend/requirements.txt #or requirements-dev.txt to include tests


Copy-Item backend\.env.example backend\.env
```

When backend dependencies change, update `backend/pyproject.toml` and regenerate the
pip requirements files with `python scripts/sync-backend-requirements.py`.

### SAM2

For SAM2 setup, follow the official instructions at <https://github.com/facebookresearch/sam2> and install it into the same active backend virtual environment. Place any downloaded models in the vlo/backend/assets/models/sams directory.

### One-click Setup

Linux / macOS:

```bash
./install.sh
```

Windows:

```batch
install.bat
```

This installs all dependencies (npm + Python via [uv](https://docs.astral.sh/uv/)),
builds the frontend, and creates `backend/.venv` for later runs.

The one-click installer does not currently install SAM2 itself. After running it. If you want masking capabilities follow the instructions further up.

After installation, continue to [Using Scripts](#using-scripts-one-click-installer) to start Vlo.

## Run

### 1. Start ComfyUI

Run ComfyUI separately on the machine that will host Vlo. By default Vlo expects
it at `http://127.0.0.1:8188`, but you can change that from the editor UI.

### 2. Run vlo

#### Option 1: Build and run in production mode manually:

Linux / macOS:

```bash
npm run build
cd backend
python -m uvicorn main:app --host 127.0.0.1 --port 6332
```

Windows (PowerShell):

```powershell
npm run build
Set-Location backend
python -m uvicorn main:app --host 127.0.0.1 --port 6332
```

#### Option 2: Dev Servers

Run both dev servers (Vite + FastAPI with hot reload):

```bash
npm run dev
```

#### Using Scripts (one click-installer)

Linux / macOS:

```bash
./run.sh
```

Windows:

```batch
run.bat
```

Opens `http://127.0.0.1:6332` in your browser. Pass `--no-browser` to skip that.

### Configuration

Edit `backend/.env` to adjust settings (created automatically by the installer):

- `COMFYUI_URL`: default `http://127.0.0.1:8188`
- `SAM2_DEVICE`: `auto`, `cpu`, or a CUDA/MPS-capable value supported by your environment
- `SAM2_CACHE_DIR`: cache location for prepared SAM2 data

## License

Vlo is licensed under the GNU Affero General Public License v3.0 or later
(AGPL-3.0-or-later). See [LICENSE](./LICENSE) for the full text.

## Contributing

Contributions are welcome, bug fixes especially (there will need to be plenty, given the stage of development). By submitting a contribution to this repository, you
agree to the [Individual Contributor License Agreement](./CLA-INDIVIDUAL.md). To summarise the agreement in short: you retain copyright over your own code, but you give licence for it to be included as part of the vlo codebase hereafter.
See [CONTRIBUTING.md](./CONTRIBUTING.md) for the contribution process.
