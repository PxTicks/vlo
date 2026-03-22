import { Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

function readFixture(name: string): string {
    return fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf-8');
}

export interface ApiMockOptions {
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
    const comfyHealthStatus = options.comfyHealthStatus ?? 'ok';
    const sam2Health = options.sam2Health ?? { status: 'ok' };

    const promptResponse = options.promptResponse ?? {
        prompt_id: 'mock-prompt-001',
        number: 1,
        node_errors: {},
    };
    const historyResponse = options.historyResponse ?? {};

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
        // Return a minimal 1x1 transparent PNG as mock mask frame
        const pngBytes = createMinimalPng();
        await route.fulfill({
            status: 200,
            contentType: 'image/png',
            body: Buffer.from(pngBytes),
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

/**
 * Creates a minimal valid 1x1 transparent PNG (67 bytes).
 */
function createMinimalPng(): Uint8Array {
    // PNG signature + IHDR + IDAT + IEND for a 1x1 RGBA transparent pixel
    return new Uint8Array([
        // PNG signature
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        // IHDR chunk (13 bytes data)
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
        0x89,
        // IDAT chunk (minimal zlib stream for 1 RGBA pixel)
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54,
        0x78, 0x9c, 0x62, 0x00, 0x00, 0x00, 0x05, 0x00,
        0x01, 0x0d, 0x0a, 0x2d, 0xb4,
        // IEND chunk
        0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
        0xae, 0x42, 0x60, 0x82,
    ]);
}
