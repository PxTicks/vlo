import {
    assetIndexDocumentSchema,
    compositeLibraryDocumentSchema,
    timelineDocumentSchema,
} from '../src/features/project/schemas/projectPersistenceSchemas';
import type { EditorComponent } from './components';
import { expect, test } from './fixtures';

/**
 * Phase 5.1–5.3 — current-format mask and composite browser journeys.
 *
 * Composition algebra and identity matrices stay below E2E. These tests own
 * the timeline gesture, panel wiring, persistence and subtimeline boundaries.
 */

const TIMELINE_PATH = '.vloproject/timeline.json';
const COMPOSITE_SESSION_PATH = '.vloproject/composite-session.json';
const MASK_PARENT_CLIP_ID = 'clip_918b868b-27df-4533-bb5c-f09d78550011';
const MASK_CLIP_ID =
    `${MASK_PARENT_CLIP_ID}::mask::e44bcce4-6af6-4a07-8811-320da10e2029`;
const COMPOSITE_ID = 'composite_effce8c8-0ef9-4e17-8482-df81b50744d8';
const COMPOSITE_PLACEMENT_ID = 'clip_6301d796-0663-4254-9462-a0848e62357d';
const COMPOSITE_INNER_CLIP_ID = 'clip_0930e057-3b5e-41b2-8ebe-3846a163e0a8';
const IMAGE_ASSET_ID = '5e0b23a4-62df-4b3b-9ad9-da1c79bb970c';

function readTimeline(editor: EditorComponent) {
    return timelineDocumentSchema.parse(editor.fileSystem.readJson(TIMELINE_PATH));
}

function readComposites(editor: EditorComponent) {
    return compositeLibraryDocumentSchema.parse(
        editor.fileSystem.readJson('.vloproject/composites.json'),
    );
}

/** The subtimeline edit left open, or null when the project holds none. */
function readCompositeSession(editor: EditorComponent) {
    if (!editor.fileSystem.exists(COMPOSITE_SESSION_PATH)) return null;
    return editor.fileSystem.readJson<{
        session: null | {
            stack: Array<{ ownerCompositeAssetId?: string | null }>;
            current: { clips: Array<{ id: string }> };
        };
    }>(COMPOSITE_SESSION_PATH).session;
}

function publishedCompositeClipIds(editor: EditorComponent): string[] {
    return readComposites(editor).composites[COMPOSITE_ID].content.clips.map(
        (clip) => clip.id,
    );
}

async function writeProjectJson(
    editor: EditorComponent,
    path: string,
    value: unknown,
) {
    await editor.page.evaluate(
        async ({ filePath, document }) => {
            const response = await fetch(`/__mock-fs/${filePath}`, {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: `${JSON.stringify(document, null, 2)}\n`,
            });
            if (!response.ok) {
                throw new Error(
                    `Failed to write ${filePath}: ${response.status}`,
                );
            }
        },
        { filePath: path, document: value },
    );
}

function waitForTimelineSave(editor: EditorComponent) {
    return editor.page.waitForResponse(
        (response) =>
            response.request().method() === 'PUT' &&
            new URL(response.url()).pathname.endsWith(
                `/__mock-fs/${TIMELINE_PATH}`,
            ) &&
            response.status() === 204,
    );
}

async function waitForTimelinePersistenceIdle(editor: EditorComponent) {
    await new Promise<void>((resolve) => {
        let quietTimer: ReturnType<typeof setTimeout>;
        const finish = () => {
            editor.page.off('response', onResponse);
            resolve();
        };
        const scheduleFinish = () => {
            clearTimeout(quietTimer);
            quietTimer = setTimeout(finish, 750);
        };
        const onResponse = (response: import('@playwright/test').Response) => {
            if (
                response.request().method() === 'PUT' &&
                new URL(response.url()).pathname.endsWith(
                    `/__mock-fs/${TIMELINE_PATH}`,
                )
            ) {
                scheduleFinish();
            }
        };
        editor.page.on('response', onResponse);
        scheduleFinish();
    });
}

test.describe('Current-project masks and composites', () => {
    test('restores a persisted brush mask after scrubbing away from its clip', async ({
        editorWithMasks,
    }) => {
        test.setTimeout(120_000);
        const editor = editorWithMasks;
        const { page, timeline } = editor;
        const timelineDocument = readTimeline(editor);
        const assetsDocument = assetIndexDocumentSchema.parse(
            editor.fileSystem.readJson('.vloproject/assets.json'),
        );
        const imageAsset = assetsDocument.assets[IMAGE_ASSET_ID];
        expect(imageAsset).toBeTruthy();

        timelineDocument.clips = timelineDocument.clips.map((clip) => {
            if (clip.id !== MASK_CLIP_ID || clip.type !== 'mask') {
                return clip;
            }
            return {
                ...clip,
                maskType: 'brush' as const,
                maskParameters: {
                    baseWidth: 2752,
                    baseHeight: 1536,
                },
                brushMaskAssetId: IMAGE_ASSET_ID,
                brushPaintedBounds: {
                    x: 0,
                    y: 0,
                    width: 2752,
                    height: 1536,
                },
                generationMaskAssetId: undefined,
            };
        });
        await writeProjectJson(editor, TIMELINE_PATH, timelineDocument);
        await editor.reopenProject();

        const maskFailures: string[] = [];
        page.on('console', (message) => {
            const text = message.text();
            if (
                /image mask source failed|failed to load image mask|failed to fetch/i.test(
                    text,
                )
            ) {
                maskFailures.push(text);
            }
        });

        const canvas = editor.player.canvasContainer.locator('canvas').first();
        const seekToPresentedFrame = async (tick: number) => {
            const sequence = await page.evaluate(() =>
                window.__vloE2E?.getLiveFramePresentation()?.sequence ?? 0,
            );
            await timeline.seekToTick(tick);
            // Cold mask hydration and shader compilation can outlast a fixed
            // delay. An exact frame awaits mask hydration in its mask sync,
            // and superseded frames are not reported, so wait for that.
            await expect
                .poll(() => page.evaluate(({ target, previous }) => {
                    const frame = window.__vloE2E?.getLiveFramePresentation();
                    return Boolean(
                        frame && frame.tick === target && frame.exact &&
                        frame.sequence > previous,
                    );
                }, { target: tick, previous: sequence }), { timeout: 30_000 })
                .toBe(true);
        };
        await seekToPresentedFrame(180_000);
        const initialMaskedFrame = await canvas.screenshot();

        await seekToPresentedFrame(480_000);
        await seekToPresentedFrame(180_000);
        expect(maskFailures).toEqual([]);
        await expect
            .poll(async () => (await canvas.screenshot()).equals(initialMaskedFrame), {
                timeout: 10_000,
            })
            .toBe(true);
    });

    test('retimes a masked clip, persists composition, then deletes the mask', async ({
        editorWithMasks,
    }) => {
        const editor = editorWithMasks;
        const { page, timeline, rightSidebar, maskPanel } = editor;
        const initialDuration = readTimeline(editor).clips.find(
            (clip) => clip.id === MASK_CLIP_ID,
        )?.timelineDuration;
        expect(initialDuration).toBeGreaterThan(0);

        await timeline.seekToTick(180_000);
        // Mask clips are subordinate model entities and intentionally are not
        // rendered as independent timeline items. Retime their supported UI
        // owner and assert the child mask follows the browser gesture.
        const parentClip = timeline.getClipById(MASK_PARENT_CLIP_ID);
        await parentClip.click({ force: true });
        const rightHandle = parentClip.getByTestId(
            'timeline-clip-resize-handle-right',
        );
        await expect(rightHandle).toBeVisible();
        const handleBox = await rightHandle.boundingBox();
        if (!handleBox) throw new Error('Mask resize handle is not visible');

        const resized = waitForTimelineSave(editor);
        await page.mouse.move(
            handleBox.x + handleBox.width / 2,
            handleBox.y + handleBox.height / 2,
        );
        await page.mouse.down();
        await page.mouse.move(handleBox.x - 48, handleBox.y + handleBox.height / 2, {
            steps: 8,
        });
        await page.mouse.up();
        await resized;

        const resizedDuration = readTimeline(editor).clips.find(
            (clip) => clip.id === MASK_CLIP_ID,
        )?.timelineDuration;
        expect(resizedDuration).toBeLessThan(initialDuration!);

        await timeline.getClipById(MASK_PARENT_CLIP_ID).click({ force: true });
        await rightSidebar.switchToTab('Mask');
        const inverseMasking = maskPanel.panel.getByRole('checkbox', {
            name: 'Inverse Mask Algebra',
        });
        await expect(inverseMasking).not.toBeChecked();
        const compositionSaved = waitForTimelineSave(editor);
        await inverseMasking.check();
        await compositionSaved;

        await editor.reopenProject();
        await timeline.seekToTick(180_000);
        await timeline.getClipById(MASK_PARENT_CLIP_ID).click({ force: true });
        await rightSidebar.switchToTab('Mask');
        await expect(
            maskPanel.panel.getByRole('checkbox', {
                name: 'Inverse Mask Algebra',
            }),
        ).toBeChecked();
        expect(
            readTimeline(editor).clips.find((clip) => clip.id === MASK_CLIP_ID)
                ?.timelineDuration,
        ).toBe(resizedDuration);

        const deleted = waitForTimelineSave(editor);
        await maskPanel.panel
            .getByRole('button', { name: 'Actions for Mask 1' })
            .click();
        await page.getByTestId('mask-actions-menu-delete').click();
        await deleted;

        const afterDelete = readTimeline(editor);
        expect(afterDelete.clips.some((clip) => clip.id === MASK_CLIP_ID)).toBe(
            false,
        );
        const parent = afterDelete.clips.find(
            (clip) => clip.id === MASK_PARENT_CLIP_ID,
        );
        expect(JSON.stringify(parent)).not.toContain(
            'e44bcce4-6af6-4a07-8811-320da10e2029',
        );
    });

    test('forks a shared composite placement edit and preserves both instances', async ({
        editorCurrent,
    }) => {
        test.setTimeout(120_000);
        const editor = editorCurrent;
        const { page, timeline, leftSidebar } = editor;

        await timeline.seekToTick(0);
        await leftSidebar.switchTo('Composite');
        const sourceCard = page.locator(
            `[data-testid="composite-card"][data-composite-id="${COMPOSITE_ID}"]`,
        );
        const placed = waitForTimelineSave(editor);
        await sourceCard.getByRole('button', { name: 'Composite actions' }).click();
        await page.getByRole('menuitem', { name: 'Place on timeline' }).click();
        await placed;

        const sharedPlacements = readTimeline(editor).clips.filter(
            (clip) => clip.compositeId === COMPOSITE_ID,
        );
        expect(sharedPlacements).toHaveLength(2);
        const secondPlacement = sharedPlacements.find(
            (clip) => clip.id !== COMPOSITE_PLACEMENT_ID,
        );
        expect(secondPlacement).toBeTruthy();

        await timeline.seekToTick(1_602_000);
        await timeline
            .getClipById(COMPOSITE_PLACEMENT_ID)
            .getByTestId('timeline-clip-composite-open')
            .click();
        await expect(
            page.getByTestId('composite-panel-back-to-main'),
        ).toBeVisible();

        await timeline.seekToTick(60_000);
        const innerClip = timeline.getClipById(COMPOSITE_INNER_CLIP_ID);
        await innerClip.click();
        await timeline.deleteSelected();
        await expect(innerClip).toHaveCount(0);

        await page.getByTestId('composite-panel-back-to-main').click();
        await expect(sourceCard).toBeVisible({ timeout: 60_000 });

        await expect
            .poll(() => {
                const timelineDocument = readTimeline(editor);
                const editedPlacement = timelineDocument.clips.find(
                    (clip) => clip.id === COMPOSITE_PLACEMENT_ID,
                );
                const untouchedPlacement = timelineDocument.clips.find(
                    (clip) => clip.id === secondPlacement!.id,
                );
                const compositeDocument = readComposites(editor);
                return {
                    compositeCount: Object.keys(
                        compositeDocument.composites,
                    ).length,
                    editedCompositeId: editedPlacement?.compositeId,
                    untouchedCompositeId: untouchedPlacement?.compositeId,
                };
            })
            .toEqual({
                compositeCount: 2,
                editedCompositeId: expect.not.stringMatching(
                    new RegExp(`^${COMPOSITE_ID}$`),
                ),
                untouchedCompositeId: COMPOSITE_ID,
            });

        const forkedCompositeId = readTimeline(editor).clips.find(
            (clip) => clip.id === COMPOSITE_PLACEMENT_ID,
        )?.compositeId;
        expect(forkedCompositeId).toBeTruthy();
        expect(
            readComposites(editor).composites[forkedCompositeId!].content.clips.some(
                (clip) => clip.id === COMPOSITE_INNER_CLIP_ID,
            ),
        ).toBe(false);
        expect(
            readComposites(editor).composites[COMPOSITE_ID].content.clips.some(
                (clip) => clip.id === COMPOSITE_INNER_CLIP_ID,
            ),
        ).toBe(true);

        await editor.reopenProject();
        const reopenedTimeline = readTimeline(editor);
        expect(
            reopenedTimeline.clips.find(
                (clip) => clip.id === COMPOSITE_PLACEMENT_ID,
            )?.compositeId,
        ).toBe(forkedCompositeId);
        expect(
            reopenedTimeline.clips.find(
                (clip) => clip.id === secondPlacement!.id,
            )?.compositeId,
        ).toBe(COMPOSITE_ID);
    });

    // Composite content is published only on the return to the main timeline,
    // and the timeline's own persistence is suspended while a subtimeline is
    // open — so without the edit-session document, closing a project mid-edit
    // lost every change made inside the composite.
    test('keeps an open subtimeline edit across a project reopen', async ({
        editorCurrent,
    }) => {
        test.setTimeout(180_000);
        const editor = editorCurrent;
        const { page, timeline, leftSidebar } = editor;

        await timeline.seekToTick(0);
        await leftSidebar.switchTo('Composite');

        await timeline.seekToTick(1_602_000);
        await timeline
            .getClipById(COMPOSITE_PLACEMENT_ID)
            .getByTestId('timeline-clip-composite-open')
            .click();
        await expect(
            page.getByTestId('composite-panel-back-to-main'),
        ).toBeVisible();

        // Edit inside the subtimeline, and never return to the main timeline.
        await timeline.seekToTick(60_000);
        const innerClip = timeline.getClipById(COMPOSITE_INNER_CLIP_ID);
        await innerClip.click();
        await timeline.deleteSelected();
        await expect(innerClip).toHaveCount(0);

        // The open edit reaches disk as a session...
        await expect
            .poll(
                () =>
                    readCompositeSession(editor)?.current.clips.map(
                        (clip) => clip.id,
                    ) ?? null,
                { timeout: 20_000 },
            )
            .not.toContain(COMPOSITE_INNER_CLIP_ID);
        expect(readCompositeSession(editor)?.stack).toHaveLength(1);
        // ...while the library still holds the last published content, so
        // nothing has been baked.
        expect(publishedCompositeClipIds(editor)).toContain(
            COMPOSITE_INNER_CLIP_ID,
        );

        await editor.reopenProject();

        // The editor comes back inside the subtimeline with the edit intact.
        await expect(page.getByTestId('timeline-back-to-main')).toBeVisible({
            timeout: 30_000,
        });
        await expect(
            timeline.getClipById(COMPOSITE_INNER_CLIP_ID),
        ).toHaveCount(0);
        expect(publishedCompositeClipIds(editor)).toContain(
            COMPOSITE_INNER_CLIP_ID,
        );

        // Returning to the main timeline publishes the edit as it always did,
        // and the session that carried it is cleared.
        await page.getByTestId('timeline-back-to-main').click();
        await expect
            .poll(() => publishedCompositeClipIds(editor), { timeout: 60_000 })
            .not.toContain(COMPOSITE_INNER_CLIP_ID);
        await expect
            .poll(() => readCompositeSession(editor), { timeout: 20_000 })
            .toBeNull();
        await expect(
            timeline.getClipById(COMPOSITE_PLACEMENT_ID),
        ).toBeVisible();
    });

    test('groups a selected range into a composite and completes its bake', async ({
        editorCurrent,
    }) => {
        test.setTimeout(180_000);
        const editor = editorCurrent;
        const { page, timeline, leftSidebar } = editor;
        const initialCompositeIds = new Set(
            Object.keys(readComposites(editor).composites),
        );

        await timeline.seekToTick(0);
        await leftSidebar.switchTo('Composite');
        await page.getByTestId('composite-create-from-selection').click();
        await expect(
            page.getByText(
                'Choose the timeline range to turn into a composite clip.',
            ),
        ).toBeVisible();
        await page.getByRole('button', { name: 'Confirm Selection' }).click();

        await expect
            .poll(
                () => Object.keys(readComposites(editor).composites).length,
                { timeout: 60_000 },
            )
            .toBe(initialCompositeIds.size + 1);
        const newCompositeId = Object.keys(
            readComposites(editor).composites,
        ).find((id) => !initialCompositeIds.has(id));
        expect(newCompositeId).toBeTruthy();

        const authoredCard = page.locator(
            `[data-testid="composite-card"][data-composite-id="${newCompositeId}"]`,
        );
        await expect(authoredCard).toBeVisible();
        await expect(
            authoredCard.getByTestId('composite-bake-status'),
        ).toContainText('Bake ready', { timeout: 120_000 });
        // Bake completion remaps the placement from its live placeholder to
        // the ready asset. Wait through the store's 250ms patch debounce and
        // any follow-up write before reloading the browser.
        await waitForTimelinePersistenceIdle(editor);

        const authoredPlacement = readTimeline(editor).clips.find(
            (clip) => clip.compositeId === newCompositeId,
        );
        expect(authoredPlacement).toMatchObject({
            start: 0,
            compositeId: newCompositeId,
        });
        expect(
            readComposites(editor).composites[newCompositeId!].bake?.status,
        ).toBe('ready');

        await editor.reopenProject();
        expect(readComposites(editor).composites[newCompositeId!]).toBeTruthy();
        expect(
            readTimeline(editor).clips.some(
                (clip) =>
                    clip.id === authoredPlacement!.id &&
                    clip.compositeId === newCompositeId,
            ),
        ).toBe(true);
    });
});
