# vlo

Vlo is a free, local, open source video editor with ComfyUI-backed generative AI features.

This project is in early alpha, but I believe its usefulness already outstrips its bugginess.

The aim is to integrate the latest-and-greatest AI tools with real video editing workflows. It's designed to support an intentional creative process, not for churning out heaps of dross, so the development priority is control, not automation. In the long run, I'd like it to grow into a tool which anyone, including those who just want to make videos, not AI videos, can benefit from.

Skip to install instructions [here](#install), or continue reading.

## Demo videos


1. Patch-based inpainting. This is necessary for optimising quality and avoiding degradation both from VAE and video encoding.


<video src="https://github.com/user-attachments/assets/a29d1b1d-097d-4526-b2c8-1dc99ec4fcc2" controls width="720"></video>


2. Motion guidance. This is using the [time-to-move](https://time-to-move.github.io/) framework. In this case we show precise control by animating the input 6332 - the default vlo port - on a keypad.

<video src="https://github.com/user-attachments/assets/d66962c4-7b37-4fea-b05a-4e0a073140ff" controls width="720"></video>

3. An sample video of a longer workflow can be [downloaded](
https://github.com/PxTicks/vlo/releases/download/v0.2.0/vlo_full_2.mp4) from the release assets (too big a file to upload inline). Some steps have been skipped for brevity, but it demonstrates the interaction between timeline and generation


## IMPORTANT

Vlo requires chromium-based browsers to work. I have tested in Edge and Chrome, but other Chromium browsers (e.g. Opera) may also function. The are two fundamental reasons for this limitation.

1. It uses the File System Access API for smooth and efficient file management directly on disk. This allows for a unified file management interface, whether you launch vlo on your own computer or on a remote service (e.g. runpod). You can still access your locally-stored project files. One caveat: it is best to keep your projects in a folder where you can easily find them, as clearing browser data will forget their location.
2. The media renderer is built on mediabunny, which wraps webcodecs. Webcodecs has implementation differences between firefox and chrome, and during early testing, this led to noticeable lag. The Webcodecs API is the basis of frame-accurate web video, and is indispensable for a project like this.

## Known issues and TODOs

Known compatibility limitations and their current workarounds are tracked in
[`docs/todos/known_issues.md`](docs/todos/known_issues.md). This includes the
partially supported arrangement where vlo runs in WSL and ComfyUI runs on
Windows.

## Features

- SAM2 points editor and masking.
  - Includes automatic cropping and stitching for video inpainting workflows.
- ComfyUI bridge, allowing images, videos and timeline selections to be sent to ComfyUI
  - Includes automatic aspect ratio adjustment (video models such as WAN and LTX2.3 cannot do all aspect ratios exactly).
- Built-in stackable adjustments and filters
- Keyframes and spline editor for all transformations (layout, adjustments and filter effects)
- Snappable markers and beat detection
- Asset organisation (hot-swappable generation groups, favourites)
- ComfyUI-backed workflows for interpolation and image and video upscaling.
- Mask algebera (unions, intersections etc)
- Draggable motion paths

## Extensions (experimental)

Vlo now has an early trusted extension runtime. Approved frontend code runs in the
editor page, and approved backend code runs with the backend process's authority;
this is a consent gate, not a sandbox. Start with the
[`extension-template`](extension-template/README.md), and read the
[`extension-system-plan`](docs/extension-system-plan.md) for the current contracts
and phased roadmap.

## Changelog (v0.2.0)

- Updated ComfyUI bridge for more responsiveness
- Updated workflow rules schema
- Added waveform visualisation for audio
- Added text rendering
- Added new workflows, including Wan TTM, animate, LTX edit and inpaint, SeedVR upscaling, GIMM-VFI interpolation.
- Added composite clips [caution - very experimental!]
- Added asset groups and favourites
- Updated mask rendering entirely, improving efficiently
- Added mask algebra, for creating complex masks (e.g. edge masks)
- Added draggable motion paths

## Try it on runpod

Runpod is a paid GPU-rental service. You can try vlo on runpod [here](https://console.runpod.io/deploy?template=vunh5oyg9t&ref=7o87c4ii).

## Install

If the idea of the command line makes you uncomfortable, you can skip to the [one-click install](#one-click-setup) section. You will still need to install ComfyUI and some custom nodes yourself if you want to use generative AI features.

### Manual install prerequisites

- Git
- Python 3.10 or newer
- Node.js 22 LTS or newer (includes npm)
- ComfyUI for generative AI features
- \[optional\] the nodes listed [here](#comfyui-integration) for default workflows

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

For SAM2 setup, make sure that torch with CUDA is installed in the backend venv, e.g.

```bash
pip3 install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu128
```

Being sure to install the version for your correct cuda environment, see <https://pytorch.org/>.

Then follow the official instructions at <https://github.com/facebookresearch/sam2> and install it into the same active backend virtual environment.

Place any downloaded models and their associated `.yaml` in `vlo/backend/assets/models/sams`. Models can be found on Hugging Face, for example <https://huggingface.co/facebook/sam2.1-hiera-large>. Use the native `.pt` checkpoint from the official repository, such as `sam2.1_hiera_large.pt`. Do not use the repository's `model.safetensors` file with vlo's native SAM2 runtime, because that artifact uses Hugging Face Transformers parameter naming and is not compatible with `facebookresearch/sam2`.

### SAM-Audio

SAM-Audio is optional and requires Python 3.11 or newer. It is intentionally not part of `backend/requirements.txt` because Meta's package owns VCS-only dependencies such as `dacvae`, ImageBind, and perception-models. Install SAM-Audio into the backend virtual environment as one unit:

```bash
python -m pip install -r backend/requirements-sam-audio.txt
```

If you are working from a local checkout, install that checkout into the backend virtual environment, or set `SAM_AUDIO_PYTHONPATH` to a path such as `~/sam-audio` after installing its dependencies.

The default model is `facebook/sam-audio-large-tv`, which is gated on Hugging Face. Accept the license and either authenticate the backend environment with `hf auth login`, pass a token through the model download flow, or place the downloaded files manually. SAM-Audio model downloads live under `vlo/backend/assets/models/sam_audio/<model-key>`, for example `vlo/backend/assets/models/sam_audio/sam-audio-large-tv/config.json` and `checkpoint.pt`. This is intentionally one folder deeper than SAM2 because SAM-Audio loads a Hugging Face-style model directory, not loose checkpoint/config files. `extra_model_paths.yaml` supports a `sam_audio` root with the same `<model-key>/{config.json,checkpoint.pt}` layout.

Transient source uploads, generated stems, and Hugging Face scratch files use `projects/.sam_audio_cache`. First runtime load can also fetch dependent T5 and PE assets, so the backend environment still needs Hugging Face access or a pre-populated cache even when the main SAM-Audio checkpoint is already present.

The app currently uses the lean isolate path and does not expose SAM-Audio's optional high-quality reranking/span-prediction mode. The backend still guards that experimental API path behind `SAM_AUDIO_LOAD_OPTIONAL_MODELS=1`; only enable it after explicitly caching/installing the CLAP, ImageBind, judge, and PE span-predictor dependencies. Compatible `xformers`, `flash-attn`, and `torchcodec` installs are used when available; if those version-sensitive packages are absent or mismatched, vlo falls back to import shims for the default tensor-based path. Restart the backend after changing any of these packages.

### Almost-one-click Setup

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

The one-click installer will prompt you to optionally set up SAM2 (including installing PyTorch with CUDA and cloning/installing SAM2) automatically.

After installation, continue to [Using Scripts](#using-scripts-almost-one-click-installer) to start vlo.

## Run

### End-to-end tests

The Playwright suite uses an isolated writable in-memory project filesystem and
mocked backend services. Install the pinned Chromium build once, then run either
the pull-request smoke suite or the full suite:

```bash
cd frontend
npx playwright install --with-deps chromium
npm run test:e2e:smoke
npm run test:e2e
```

Run one file or test while iterating:

```bash
npx playwright test e2e/timeline.spec.ts
npx playwright test --grep "adjustment clip"
npm run test:e2e:ui
```

Set `PLAYWRIGHT_BASE_URL` to test an already-running server. Local runs use the
Vite development server; CI builds first and uses `vite preview`. Pull requests
run `@smoke` tests, while the complete Chromium suite runs nightly and through
manual workflow dispatch.

### 1. Start ComfyUI

Run ComfyUI separately on the machine that will host vlo. By default vlo expects
it at `http://127.0.0.1:8188`, but you can change that from the editor UI.

Optionally, point `COMFYUI_INSTALL_DIR` in `backend/.env` at your existing ComfyUI
installation directory. When set, vlo activates its in-app model download facility,
letting you fetch models required by workflows directly from the editor (downloaded
into `<COMFYUI_INSTALL_DIR>/models/...`). Leave it unset to disable in-app downloads.

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

#### Using Scripts (almost-one-click installer)

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

If needed, create `backend/.env` from `backend/.env.example` to adjust settings. You may be able to ignore this step.

- `COMFYUI_URL`: default `http://127.0.0.1:8188`
- `COMFYUI_INSTALL_DIR`: path to an existing ComfyUI install. When set, enables the in-app model download facility (models are saved to `<COMFYUI_INSTALL_DIR>/models/...`); leave unset to disable
- `SAM2_DEVICE`: `auto`, `cpu`, or a CUDA/MPS-capable value supported by your environment
- `SAM2_CACHE_DIR`: cache location for prepared SAM2 data

## ComfyUI Integration

It should be possible for the majority of workflows to function with vlo as-is. If you need enhanced functionality, then there is a sidecar rules system, which deals with aspect ratio adjustment, mask processing etc.

For details on how workflows interact with vlo — sidecars, widget exposure,
aspect ratio processing, and the generation pipeline — see the
[Workflow rule guide](backend/assets/workflows/HOW_TO_WRITE_WORKFLOW_RULES.md). The
[default workflows](backend/assets/.config/default_workflows/) include working
sidecar examples. A custom GPT is available [here](https://chatgpt.com/g/g-69f93b02dc108191a7b6cfed9dd6b08e-vlo-workflow-rules), into which you can plug in a workflow and request a rules file for if you need more complex functionality.

The following nodes are used in some capacity in the default workflows. Either install them yourself, or use the small helper script:
[`scripts/install-comfyui-nodes.py`](scripts/install-comfyui-nodes.py), running it in whichever venv ComfyUI uses on your machine.

```bash
python scripts/install-comfyui-nodes.py
```

<!-- comfyui-custom-nodes:start -->

- https://github.com/kijai/ComfyUI-WanVideoWrapper
- https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler
- https://github.com/Lightricks/ComfyUI-LTXVideo
- https://github.com/PxTicks/ComfyUI-vlo
- https://github.com/Fannovel16/comfyui_controlnet_aux
- https://github.com/kijai/ComfyUI-GIMM-VFI
- https://github.com/kijai/ComfyUI-MelBandRoFormer
- https://github.com/kosinkadink/ComfyUI-VideoHelperSuite
- https://github.com/kijai/ComfyUI-KJNodes
<!-- comfyui-custom-nodes:end -->

For better live previews from Wan workflows, start ComfyUI with TAESD previews
enabled:

```bash
cd /path/to/ComfyUI
python main.py --preview-method taesd
```

You will also need the Wan TAESD model. Download
[`taew2_1.safetensors`](https://huggingface.co/Kijai/WanVideo_comfy/resolve/main/taew2_1.safetensors)
and place it at `ComfyUI/models/vae_approx/taew2_1.safetensors`, creating the
`vae_approx` directory if it does not already exist.

## Acknowledgements

The following three open source projects are central to vlo:

- [ComfyUI](https://comfy.org/)
- [PixiJS](https://pixijs.com/)
- [Mediabunny](https://mediabunny.dev/)

The work of the following users has also been valuable:

- [kijai](https://github.com/kijai) nodes, workflows and reference code.
- [kosinkadink](https://github.com/kosinkadink) nodes and reference code.
- [RuneXX](https://huggingface.co/RuneXX) workflows.

## License

Vlo is licensed under the GNU Affero General Public License v3.0 or later
(AGPL-3.0-or-later). See [LICENSE](./LICENSE) for the full text.

## Contributing

Contributions are welcome, bug fixes especially (there will need to be plenty, given the stage of development). By submitting a contribution to this repository, you
agree to the [Individual Contributor License Agreement](./CLA-INDIVIDUAL.md). To summarise the agreement in short: you retain copyright over your own code, but you give licence for it to be included as part of the vlo codebase hereafter.
See [CONTRIBUTING.md](./CONTRIBUTING.md) for the contribution process.
