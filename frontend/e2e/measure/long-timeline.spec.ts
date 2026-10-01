import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { EditorComponent } from '../components';
import { installApiMock } from '../mocks/apiMock';
import { installWebSocketMock } from '../mocks/websocketMock';
import {
    LONG_TIMELINE_DEFAULT_REPETITIONS,
    PROJECT_CURRENT_BEAT_AUDIO,
    buildLongTimelineFixture,
    toLongTimelineDocument,
} from '../../src/features/timeline/__tests__/fixtures/longTimelineFixture';
import { readProjectCurrentTimeline } from '../../src/features/timeline/__tests__/fixtures/longTimelineFixtureSource';

/**
 * Long-timeline editor responsiveness in real Chromium
 * (docs/long-timeline-performance-plan.md, workstream 0). Not a test: it
 * measures and reports, and nothing gates on the numbers.
 *
 *   PLAYWRIGHT_MEASURE_HEADLESS=1 npx playwright test --project=export-measure e2e/measure/long-timeline.spec.ts
 *
 * LONG_TIMELINE_REPETITIONS: copies of project_current (13 clips each).
 *
 * The generated project (project_current's media plus the repeated
 * timeline) is written under test-results/ and opened through the mock
 * filesystem, with the API and websocket mocked.
 */
const REPETITIONS = Number(
    process.env.LONG_TIMELINE_REPETITIONS ?? LONG_TIMELINE_DEFAULT_REPETITIONS,
);
const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const OUT_DIR = resolve('test-results/long-timeline-measure');
const PROJECT_DIR = resolve(OUT_DIR, 'project');
const SCROLL_FRAMES = 240;
const SCROLL_PX_PER_FRAME = 40;
const ZOOM_SAMPLES = 6;
const EDIT_SAMPLES = 6;

interface FrameStats {
    frames: number;
    medianMs: number;
    p95Ms: number;
    maxMs: number;
    over50Ms: number;
    longTaskMs: number;
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    return Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10;
}

function writeProject(): { clips: number; nonMaskClips: number } {
    const fixture = buildLongTimelineFixture(readProjectCurrentTimeline(), {
        repetitions: REPETITIONS,
        audio: PROJECT_CURRENT_BEAT_AUDIO,
    });
    rmSync(PROJECT_DIR, { recursive: true, force: true });
    mkdirSync(OUT_DIR, { recursive: true });
    cpSync(resolve(FIXTURES_DIR, 'project_current'), PROJECT_DIR, {
        recursive: true,
    });
    writeFileSync(
        resolve(PROJECT_DIR, '.vloproject', 'timeline.json'),
        `${JSON.stringify(toLongTimelineDocument(fixture, Date.now()), null, 2)}\n`,
    );
    return {
        clips: fixture.clips.length,
        nonMaskClips: fixture.clips.filter((clip) => clip.type !== 'mask').length,
    };
}

/** Time from `action` (run in the page) to the second animation frame after it. */
async function timeToPaint(page: Page, action: string, argument: unknown): Promise<number> {
    return page.evaluate(
        async ([source, arg]) => {
            const run = new Function('arg', source) as (arg: unknown) => void;
            const nextFrame = () => new Promise<void>((done) => requestAnimationFrame(() => done()));
            await nextFrame();
            const start = performance.now();
            run(arg);
            await nextFrame();
            await nextFrame();
            return performance.now() - start;
        },
        [action, argument] as const,
    );
}

async function measureScroll(page: Page): Promise<FrameStats> {
    return page.evaluate(
        async ({ frames, step }) => {
            const container = document.querySelector<HTMLElement>(
                '[data-testid="timeline-scroll-container"]',
            );
            if (!container) throw new Error('timeline scroll container not found');
            container.scrollLeft = 0;

            let longTaskMs = 0;
            const observer = new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) longTaskMs += entry.duration;
            });
            observer.observe({ type: 'longtask', buffered: false });

            const intervals: number[] = await new Promise((done) => {
                const deltas: number[] = [];
                let previous = 0;
                const tick = (now: number) => {
                    if (previous) deltas.push(now - previous);
                    previous = now;
                    container.scrollLeft += step;
                    if (deltas.length >= frames) done(deltas);
                    else requestAnimationFrame(tick);
                };
                requestAnimationFrame(tick);
            });
            observer.disconnect();

            const sorted = [...intervals].sort((a, b) => a - b);
            const round = (value: number) => Math.round(value * 10) / 10;
            return {
                frames: intervals.length,
                medianMs: round(sorted[Math.floor(sorted.length / 2)]),
                p95Ms: round(sorted[Math.floor(sorted.length * 0.95)]),
                maxMs: round(sorted[sorted.length - 1]),
                over50Ms: intervals.filter((ms) => ms > 50).length,
                longTaskMs: round(longTaskMs),
            };
        },
        { frames: SCROLL_FRAMES, step: SCROLL_PX_PER_FRAME },
    );
}

/**
 * Scrolls to the middle of the timeline and returns the video clip drawn
 * nearest the viewport centre. The edit sample must change something on
 * screen: once clips are virtualized, an offscreen edit would paint nothing
 * and look cheaper than it is.
 */
async function pickVisibleMidTimelineVideo(page: Page): Promise<string> {
    return page.evaluate(async () => {
        const container = document.querySelector<HTMLElement>(
            '[data-testid="timeline-scroll-container"]',
        );
        if (!container) throw new Error('timeline scroll container not found');
        container.scrollLeft = (container.scrollWidth - container.clientWidth) / 2;
        const nextFrame = () => new Promise<void>((done) => requestAnimationFrame(() => done()));
        await nextFrame();
        await nextFrame();

        const store = (window as unknown as {
            __TIMELINE_STORE__: { getState(): { clips: { id: string; type: string }[] } };
        }).__TIMELINE_STORE__;
        const videoIds = new Set(
            store.getState().clips.filter((clip) => clip.type === 'video').map((clip) => clip.id),
        );
        const view = container.getBoundingClientRect();
        const centreX = view.left + view.width / 2;
        let best: { id: string; distance: number } | null = null;
        for (const node of container.querySelectorAll<HTMLElement>('[data-clip-id]')) {
            const id = node.dataset.clipId ?? '';
            const rect = node.getBoundingClientRect();
            const onScreen =
                rect.right > view.left && rect.left < view.right &&
                rect.bottom > view.top && rect.top < view.bottom;
            if (!videoIds.has(id) || !onScreen) continue;
            const distance = Math.abs((rect.left + rect.right) / 2 - centreX);
            if (!best || distance < best.distance) best = { id, distance };
        }
        if (!best) throw new Error('no video clip visible at the middle of the timeline');
        return best.id;
    });
}

test.use({
    launchOptions: {
        args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    },
});

test('long timeline responsiveness', async ({ page, baseURL }) => {
    test.setTimeout(10 * 60_000);
    const fixture = writeProject();
    const editor = new EditorComponent(page);
    await installWebSocketMock(page);
    await installApiMock(page);

    // 1. Open the project and wait for the timeline to show clips. The clock
    // starts at the Open project click, after the mock filesystem and app load.
    let openStart = 0;
    await editor.setup({
        fixtureDir: PROJECT_DIR,
        appURL: new URL('/', baseURL).href,
        onProjectMenu: async () => {
            openStart = Date.now();
        },
    });
    await expect(editor.timeline.clips.first()).toBeVisible({ timeout: 120_000 });
    const openMs = Date.now() - openStart;
    const mountedClips = await editor.timeline.getClipCount();

    // 2. Horizontal scroll, one step per animation frame.
    const scroll = await measureScroll(page);

    // 3. Ctrl+wheel zoom at the viewport centre, alternating in and out.
    const zoomSamples: number[] = [];
    for (let index = 0; index < ZOOM_SAMPLES; index += 1) {
        zoomSamples.push(
            await timeToPaint(
                page,
                `const container = document.querySelector('[data-testid="timeline-scroll-container"]');
                 const rect = container.getBoundingClientRect();
                 container.dispatchEvent(new WheelEvent('wheel', {
                     ctrlKey: true, cancelable: true, bubbles: true, deltaY: arg,
                     clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
                 }));`,
                index % 2 === 0 ? -200 : 200,
            ),
        );
    }

    // 4. One-clip edit (mute toggle) through the store, to the next paint.
    const editedClipId = await pickVisibleMidTimelineVideo(page);
    const editSamples: number[] = [];
    for (let index = 0; index < EDIT_SAMPLES; index += 1) {
        editSamples.push(
            await timeToPaint(
                page,
                'window.__TIMELINE_STORE__.getState().toggleClipMute(arg);',
                editedClipId,
            ),
        );
    }

    const result = {
        recordedAt: new Date().toISOString(),
        fixture: { repetitions: REPETITIONS, ...fixture },
        openToClipsVisibleMs: openMs,
        mountedTimelineClipNodes: mountedClips,
        scroll,
        zoomToPaintMedianMs: median(zoomSamples),
        zoomToPaintSamplesMs: zoomSamples.map((ms) => Math.round(ms)),
        editToPaintMedianMs: median(editSamples),
        editToPaintSamplesMs: editSamples.map((ms) => Math.round(ms)),
    };
    writeFileSync(resolve(OUT_DIR, 'latest.json'), `${JSON.stringify(result, null, 2)}\n`);
    console.log(
        [
            `long timeline: ${fixture.clips} clips (${fixture.nonMaskClips} non-mask), ${mountedClips} mounted`,
            `  open to clips visible   ${openMs} ms`,
            `  scroll frame            median ${scroll.medianMs} ms, p95 ${scroll.p95Ms} ms, max ${scroll.maxMs} ms, ` +
                `${scroll.over50Ms}/${scroll.frames} frames > 50 ms, long tasks ${scroll.longTaskMs} ms`,
            `  zoom to paint           median ${result.zoomToPaintMedianMs} ms`,
            `  edit to paint           median ${result.editToPaintMedianMs} ms`,
            `  written to ${resolve(OUT_DIR, 'latest.json')}`,
        ].join('\n'),
    );
});
