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
        await timeline.seekToTick(180_000);
        await page.waitForTimeout(500);
        const initialMaskedFrame = await canvas.screenshot();

        await timeline.seekToTick(480_000);
        await timeline.seekToTick(180_000);
        await page.waitForTimeout(500);
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
            name: 'Inverse Masking',
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
                name: 'Inverse Masking',
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
        await sourceCard
            .getByRole('button', { name: 'Place composite on timeline' })
            .click();
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
        ).toHaveText('Bake ready', { timeout: 120_000 });
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
