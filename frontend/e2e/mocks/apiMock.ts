import { Page, Route } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const SAM2_FRAME_PREVIEW_PATH = path.join(
    __dirname,
    '..',
    'fixtures',
    'project_v2_with_clips',
    '.vloproject',
    'thumbnails',
    'A_woman_in_202601222322_bssr2mp4_thumb.jpg',
);

function readFixture(name: string): string {
    return fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf-8');
}

function buildMockComfyFrameHtml(): string {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Mock ComfyUI Frame</title>
  </head>
  <body>
    <script>
      (() => {
        const workflowApi = {
          workflows: [],
          openWorkflows: [],
          activeWorkflow: null,
          async closeWorkflow(workflow) {
            this.workflows = this.workflows.filter((candidate) => candidate !== workflow);
            this.openWorkflows = this.openWorkflows.filter((candidate) => candidate !== workflow);
            if (this.activeWorkflow === workflow) {
              this.activeWorkflow = this.workflows[0] ?? null;
            }
          },
        };

        function normalizeFilename(value) {
          const trimmed = String(value ?? '').trim();
          return trimmed.length > 0 ? trimmed : 'workflow.json';
        }

        function setActiveWorkflow(graphData, filename) {
          const normalizedFilename = normalizeFilename(filename);
          const workflow = {
            filename: normalizedFilename,
            fullFilename: normalizedFilename,
            path: normalizedFilename,
            activeState: graphData,
            pendingWarnings: null,
          };
          workflowApi.workflows = [workflow];
          workflowApi.openWorkflows = [workflow];
          workflowApi.activeWorkflow = workflow;
        }

        window.app = {
          async handleFile(file) {
            const text = await file.text();
            const graphData = JSON.parse(text);
            setActiveWorkflow(graphData, file && 'name' in file ? file.name : 'workflow.json');
          },
          async graphToPrompt() {
            const graphData = workflowApi.activeWorkflow && workflowApi.activeWorkflow.activeState;
            if (!graphData) {
              return null;
            }
            return [graphData, graphData];
          },
          extensionManager: {
            workflow: workflowApi,
          },
          api: {
            socket: {
              connected: true,
              readyState: 1,
              OPEN: 1,
            },
          },
        };

        window.api = {
          socket: {
            connected: true,
            readyState: 1,
            OPEN: 1,
          },
        };
      })();
    </script>
  </body>
</html>`;
}

export interface ApiMockOptions {
    /** Override /app/status RuntimeStatus response. */
    runtimeStatus?: {
        backend?: { status?: string; mode?: string; frontendBuildPresent?: boolean };
        comfyui?: { status?: string; url?: string; error?: string | null };
        sam2?: { status?: string; error?: string | null };
    };
    /** Make /app/status return an error (e.g. 500). Default: false */
    runtimeStatusError?: boolean;
    /** Override /comfy/health response status. Default: "ok" */
    comfyHealthStatus?: string;
    /** Override /sam2/health response. Default: { status: "ok" } */
    sam2Health?: Record<string, unknown>;
    /** Override workflow list. Default: loaded from fixtures/workflow-list.json */
    workflowList?: Array<{ id: string; name: string }>;
    /** Override prompt response. Default: mock job ID */
    promptResponse?: Record<string, unknown>;
    /** Override history response per prompt ID. Default: empty results */
    historyResponse?: Record<string, unknown>;
}

/**
 * Installs route-level API mocking for ComfyUI and SAM2 backend endpoints.
 * Same pattern as mockFileSystem.ts — uses page.route() for network interception.
 *
 * Call before navigating to the app.
 */
export async function installApiMock(page: Page, options: ApiMockOptions = {}) {
    const workflowList = options.workflowList
        ?? JSON.parse(readFixture('workflow-list.json'));
    const workflowContent = JSON.parse(readFixture('workflow-content.json'));
    const workflowRules = JSON.parse(readFixture('workflow-rules.json'));
    const objectInfo = JSON.parse(readFixture('object-info.json'));
    const comfyFrameHtml = buildMockComfyFrameHtml();
    const comfyHealthStatus = options.comfyHealthStatus ?? 'ok';
    const sam2Health = options.sam2Health ?? { status: 'ok' };

    const promptResponse = options.promptResponse ?? {
        prompt_id: 'mock-prompt-001',
        number: 1,
        node_errors: {},
    };
    const historyResponse = options.historyResponse ?? {};

    // ── App status endpoint ──

    const defaultRuntimeStatus = {
        backend: { status: 'ok', mode: 'development', frontendBuildPresent: true },
        comfyui: { status: 'connected', url: 'http://localhost:8188', error: null },
        sam2: { status: 'available', error: null },
    };

    if (options.runtimeStatus) {
        if (options.runtimeStatus.backend) Object.assign(defaultRuntimeStatus.backend, options.runtimeStatus.backend);
        if (options.runtimeStatus.comfyui) Object.assign(defaultRuntimeStatus.comfyui, options.runtimeStatus.comfyui);
        if (options.runtimeStatus.sam2) Object.assign(defaultRuntimeStatus.sam2, options.runtimeStatus.sam2);
    }

    await page.route('**/app/status', async (route) => {
        if (options.runtimeStatusError) {
            await route.fulfill({ status: 500, body: 'Internal Server Error' });
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(defaultRuntimeStatus),
        });
    });

    // ── ComfyUI iframe shell ──

    const fulfillComfyFrame = async (route: Route) => {
        await route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: comfyFrameHtml,
        });
    };

    await page.route('**/comfyui-frame', fulfillComfyFrame);
    await page.route('**/comfyui-frame/', fulfillComfyFrame);
    await page.route('**/comfyui-frame/**', fulfillComfyFrame);

    // ── ComfyUI endpoints ──

    await page.route('**/comfy/health', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ status: comfyHealthStatus }),
        });
    });

    await page.route('**/comfy/config', async (route) => {
        if (route.request().method() === 'GET') {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ comfyui_url: 'http://localhost:8188' }),
            });
        } else {
            await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
        }
    });

    await page.route('**/comfy/workflow/list', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(workflowList),
        });
    });

    await page.route('**/comfy/workflow/content/*', async (route) => {
        if (route.request().method() === 'PUT') {
            await route.fulfill({ status: 200 });
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(workflowContent),
        });
    });

    await page.route('**/comfy/workflow/rules/*', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(workflowRules),
        });
    });

    await page.route('**/comfy/prompt', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(promptResponse),
        });
    });

    await page.route('**/comfy/generate', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(promptResponse),
        });
    });

    await page.route('**/comfy/history/*', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(historyResponse),
        });
    });

    await page.route('**/comfy/api/object_info', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(objectInfo),
        });
    });

    await page.route('**/comfy/object_info/sync', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ synced: true, node_classes: Object.keys(objectInfo).length }),
        });
    });

    await page.route('**/comfy/api/interrupt', async (route) => {
        await route.fulfill({ status: 200 });
    });

    // ── SAM2 endpoints ──

    await page.route('**/sam2/health', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(sam2Health),
        });
    });

    await page.route('**/sam2/sources', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                sourceId: 'mock-source-001',
                width: 1280,
                height: 720,
                fps: 24,
                frameCount: 72,
                durationSec: 3,
            }),
        });
    });

    await page.route('**/sam2/editor/session/init', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                sourceId: 'mock-source-001',
                maskId: 'mock-mask-001',
                width: 1280,
                height: 720,
                fps: 24,
                frameCount: 72,
            }),
        });
    });

    await page.route('**/sam2/editor/session/clear', async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await page.route('**/sam2/masks/frame', async (route) => {
        const previewImageBytes = fs.readFileSync(SAM2_FRAME_PREVIEW_PATH);
        await route.fulfill({
            status: 200,
            contentType: 'image/jpeg',
            body: previewImageBytes,
            headers: {
                'X-Sam2-Width': '1280',
                'X-Sam2-Height': '720',
                'X-Sam2-Fps': '24',
                'X-Sam2-Frame-Count': '72',
                'X-Sam2-Frame-Index': '0',
                'X-Sam2-Time-Ticks': '0',
            },
        });
    });

    await page.route('**/sam2/masks/generate', async (route) => {
        // Return a minimal WebM-like blob for mask video
        await route.fulfill({
            status: 200,
            contentType: 'video/webm',
            body: Buffer.alloc(64), // placeholder bytes
            headers: {
                'X-Sam2-Width': '1280',
                'X-Sam2-Height': '720',
                'X-Sam2-Fps': '24',
                'X-Sam2-Frame-Count': '72',
            },
        });
    });

    // ── Catch-all for /comfy/ws — prevent real WebSocket from failing ──
    // WebSocket mocking is handled separately via websocketMock.ts
}
