# vlo

Skip to install instructions [here](#install), or continue reading.

Vlo is a free, local, open source video editor with AI features.

It is extensible, with the goal of making it a playground for cutting-edge tools which may not yet exist in commercial products. It integrates AI tools with real video editing workflows, including tools for automatic rotoscoping, semantic audio extraction, beat detection etc. It also has a live bridge to ComfyUI, to run *any* possible ComfyUI workflow, and it includes bespoke workflows tailored for using AI models to edit live on the timeline.

Ultimately I want vlo to be useful for *anyone* who wants to make videos, so it is free, extensible and open source.  It aims to handle the tricky design problems of building a proper frame-accurate nonlinear video editor so that you can build extensions and code (or vibe) your own effects.


## Screenshots


Vlo is project-based. All projects are stored locally on your PC, and can be edited whether running vlo locally or on a remote GPU.

![landing](
https://github.com/PxTicks/vlo/releases/download/v0.3.0/landing.png)

It has dedicated generative workflows, and a live bridge to ComfyUI which can be used to edit video anywhere on the timeline.

![main_editor](
https://github.com/PxTicks/vlo/releases/download/v0.3.0/main_editor.png)

These are combined with traditional video editing features, such as color grading.

![color_grade](
https://github.com/PxTicks/vlo/releases/download/v0.3.0/color_grade.png)


### Demo
A short trailer for vlo made within the app itself: https://www.youtube.com/watch?v=G7HgMuUyfS0

## IMPORTANT

Vlo requires chromium-based browsers to work. I have tested in Edge and Chrome, but other Chromium browsers (e.g. Opera) may also function. The are two fundamental reasons for this limitation.

1. It uses the File System Access API for smooth and efficient file management directly on disk. This allows for a unified file management interface, whether you launch vlo on your own computer or on a remote service (e.g. runpod). You can still access your locally-stored project files. One caveat: it is best to keep your projects in a folder where you can easily find them, as clearing browser data will forget their location.
2. The media renderer is built on mediabunny, which wraps webcodecs. Webcodecs has implementation differences between firefox and chrome, and during early testing, this led to noticeable lag. The Webcodecs API is the basis of frame-accurate web video, and is indispensable for a project like this.


## Features

- SAM2 points editor and masking.
  - Includes automatic cropping and stitching for video inpainting workflows.
- ComfyUI bridge, allowing images, videos and timeline selections to be sent to ComfyUI
  - Includes automatic aspect ratio adjustment so any video model can be used to edit any video without cropping.
- Built-in adjustments (color grading, audio, layout) and filters
- Keyframes and spline editor for all transformations (layout, adjustments and filter effects)
- Snappable markers and beat detection
- Asset organisation (hot-swappable generation groups, favourites)
- ComfyUI-backed workflows for image and video generation, inpainting and upscaling.
- Mask algebera (unions, intersections etc)
- Draggable motion paths
- Sam-audio for audio stem separation
- Adjustment clips for whole-timeline operations
- Blending modes for clip layers.
- Color grading
- Transitions (dissolve, slide in etc.)

## Releases

See the [latest release](https://github.com/PxTicks/vlo/releases/latest) for
release notes, and [CHANGELOG.md](CHANGELOG.md) for version history.

## What's next?
v0.4.0 will have a new graph-data model for efficient resource management and parameter sharing (e.g. of masks between clips), as well as graph-based shader execution to enhance the transformations and color grading features (think Davinci Resolve's node-based color page). To make proper use of these, a per-clip workspace mode will be introduced.

## Install

Vlo needs three things: the app itself, a Chromium-based browser to run it in,
and — for generative AI features only — ComfyUI. The installer sets up the app,
and vlo installs, launches and feeds ComfyUI from inside the editor.

**The only prerequisite is [git](https://git-scm.com/downloads).** Node.js,
Python and uv are downloaded by the installer if your machine does not already
have suitable versions. Git is also what vlo uses to fetch ComfyUI and its
custom nodes later, so install it first.

### Quick start

Linux / macOS:

```bash
git clone https://github.com/PxTicks/vlo
cd vlo
./install.sh
./run.sh
```

Windows:

```batch
git clone https://github.com/PxTicks/vlo
cd vlo
install.bat
run.bat
```

### Update

Close vlo, then run the updater from the installation folder. It fetches the
latest source and reruns the installer to update dependencies and rebuild the
frontend:

```bash
./update.sh
```

```batch
update.bat
```

The updater uses the checkout's existing branch and upstream. Projects, models,
virtual environments, runtime settings, and other ignored local data stay where
they are.


### First launch: connecting ComfyUI

On first start vlo asks how you want to use ComfyUI:

- **Install ComfyUI** — choose a folder, and vlo clones ComfyUI, creates a
  dedicated virtual environment for it, installs its requirements, adds vlo's
  recommended custom nodes, and remembers the location. Nothing to configure
  afterwards.
- **Choose ComfyUI folder** — point vlo at an install you already have. See
  [Existing ComfyUI installs](#existing-comfyui-installs).
- **Continue without generative AI** — everything except generation still works.
  You can set ComfyUI up later in **App settings → Runtime settings**.

Once vlo knows about a ComfyUI install, the Generate panel offers **Launch
ComfyUI**, which starts the process and connects to it; there is no need to run
ComfyUI in a second terminal. If the checkout has no virtual environment, vlo
offers to create a managed one.

Models are fetched from inside the app as well:

- **Workflow models** — pick a workflow in the Generate panel and vlo lists what
  is missing and downloads it into `<ComfyUI>/models/…`.
- **SAM2 checkpoints** — offered in the mask editor when no model is present.
- **SAM-Audio models** — offered by the audio separation flow.

Models gated on Hugging Face ask for an access token in the download dialog.

### Existing ComfyUI installs

Point vlo at the folder containing ComfyUI's `main.py`, either from the
first-launch dialog or from **App settings → Runtime settings → ComfyUI install
directory**. Vlo verifies the folder and enables in-app model downloads for it.

Vlo does not install custom nodes into an environment it did not create, so add
the ones the default workflows use yourself. Run this inside whichever Python
environment your ComfyUI uses:

```bash
python scripts/install-comfyui-nodes.py
```

The node list, and what the sidecar rules system does with them, is in
[ComfyUI Integration](#comfyui-integration).

Running vlo in WSL against a ComfyUI on Windows is only partly supported: the
install and launch actions are not WSL-aware, so start ComfyUI from Windows and
give vlo the `/mnt/...` path to the same checkout. See
[`docs/todos/known_issues.md`](docs/todos/known_issues.md).

### Manual install (development)

Prerequisites for the manual path: git, Python 3.10 or newer, and Node.js
20.19+ or 22.13+ (includes npm).

It is recommended to set up a Python virtual environment (`venv`) before installing dependencies and to run all commands within that environment. Use Python 3.10 or newer.

Linux / macOS:

```bash
git clone https://github.com/PxTicks/vlo
cd vlo

# Frontend (installs exactly the versions pinned in the lockfiles)
npm ci
npm ci --prefix frontend

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

# Frontend (installs exactly the versions pinned in the lockfiles)
npm ci
npm ci --prefix frontend

# Backend venv (recommended)
python -m venv backend/.venv
backend\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r backend/requirements.txt #or requirements-dev.txt to include tests


Copy-Item backend\.env.example backend\.env
```

When backend dependencies change, update `backend/pyproject.toml` and regenerate the
pip requirements files with `python scripts/sync-backend-requirements.py`.


## Run

### Everyday use

Linux / macOS:

```bash
./run.sh
```

Windows:

```batch
run.bat
```

Opens `http://127.0.0.1:6332` in your browser. Pass `--no-browser` to skip that,
or `--host=` / `--port=` to change where vlo listens.

Start ComfyUI from the Generate panel's **Launch ComfyUI** button, or run it
yourself if you prefer. By default vlo expects it at `http://127.0.0.1:8188`;
change that in **App settings → Runtime settings** if it lives elsewhere.

### Dev servers

Run both dev servers (Vite + FastAPI with hot reload):

```bash
npm run dev
```

### Production build by hand

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

### Configuration

Settings you change in the app — ComfyUI URL, ComfyUI install directory,
workflow mode — are persisted under `backend/runtime/` and survive restarts. A
normal install needs no configuration by hand.

`backend/.env` (copied from `backend/.env.example`) is still read at startup,
which is useful for headless or scripted setups:

- `COMFYUI_URL`: default `http://127.0.0.1:8188`. The value set in the app wins once you change it there
- `COMFYUI_INSTALL_DIR`: path to an existing ComfyUI install, used as the starting value until the app records one. Model downloads need a configured install directory and a local ComfyUI URL
- `SAM2_DEVICE`: `auto`, `cpu`, or a CUDA/MPS-capable value supported by your environment
- `SAM2_CACHE_DIR`: cache location for prepared SAM2 data
- `SAM2_MAX_PROPAGATION_FRAMES`: maximum visible source-window length accepted by SAM2 (defaults to `900`; set to `0` to disable the limit)

## Development

### Extensions

You can add extensions to vlo. The 
[`extension-template`](extension-template/README.md). The extensions subfolder has some skills for ai-assisted development. I don't like putting out ai-written documentation which I haven't reviewed myself, so human-friendly docs still outstanding.


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

## ComfyUI Integration

It should be possible for the majority of workflows to function with vlo as-is. If you need enhanced functionality, then there is a sidecar rules system, which deals with aspect ratio adjustment, mask processing etc.

For details on how workflows interact with vlo — sidecars, widget exposure,
aspect ratio processing, and the generation pipeline — see the
[Workflow rule guide](backend/assets/workflows/HOW_TO_WRITE_WORKFLOW_RULES.md). The
[default workflows](backend/assets/.config/default_workflows/) include working
sidecar examples. A custom GPT is available [here](https://chatgpt.com/g/g-69f93b02dc108191a7b6cfed9dd6b08e-vlo-workflow-rules), into which you can plug in a workflow and request a rules file for if you need more complex functionality.

The following nodes are used in some capacity in the default workflows. A
ComfyUI installed by vlo already has them all except ComfyUI-WanVideoWrapper. For
any other install, either add them yourself or use the small helper script
[`scripts/install-comfyui-nodes.py`](scripts/install-comfyui-nodes.py), running it
in whichever venv ComfyUI uses on your machine.

```bash
python scripts/install-comfyui-nodes.py
```

<!-- comfyui-custom-nodes:start -->

- https://github.com/kijai/ComfyUI-WanVideoWrapper
- https://github.com/Lightricks/ComfyUI-LTXVideo
- https://github.com/xmarre/ComfyUI-Spectrum-MiniMax-H3
- https://github.com/PxTicks/ComfyUI-vlo
- https://github.com/Fannovel16/comfyui_controlnet_aux
- https://github.com/kijai/ComfyUI-GIMM-VFI
- https://github.com/kosinkadink/ComfyUI-VideoHelperSuite
- https://github.com/kijai/ComfyUI-KJNodes
<!-- comfyui-custom-nodes:end -->

When vlo launches ComfyUI itself, it passes `--enable-manager` and
`--preview-method latent2rgb`, so ComfyUI-Manager is available and sampling streams
live previews. Flags a checkout's argument parser does not advertise are
dropped, so older ComfyUI versions still start. Starting ComfyUI yourself, the
equivalent is:

```bash
cd /path/to/ComfyUI
python main.py --enable-manager --preview-method latent2rgb
```

The `latent2rgb` preview method does not require a model in
`ComfyUI/models/vae_approx`.

## Acknowledgements

The following three open source projects are central to vlo:

- [ComfyUI](https://comfy.org/)
- [PixiJS](https://pixijs.com/)
- [Mediabunny](https://mediabunny.dev/)

The work of the following users has also been valuable:

- [kijai](https://github.com/kijai) nodes, workflows and reference code.
- [kosinkadink](https://github.com/kosinkadink) nodes and reference code.
- [RuneXX](https://huggingface.co/RuneXX) workflows.
- [drozbay](https://github.com/drozbay) (aka AbleJones) - ideas for workflows.

## License

Vlo is licensed under the GNU Affero General Public License v3.0 or later
(AGPL-3.0-or-later). See [LICENSE](./LICENSE) for the full text.

## Contributing

Contributions are welcome, bug fixes especially (there will need to be plenty, given the stage of development). By submitting a contribution to this repository, you
agree to the [Individual Contributor License Agreement](./CLA-INDIVIDUAL.md). To summarise the agreement in short: you retain copyright over your own code, but you give licence for it to be included as part of the vlo codebase hereafter.
See [CONTRIBUTING.md](./CONTRIBUTING.md) for the contribution process.
