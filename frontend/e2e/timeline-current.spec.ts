import { timelineDocumentSchema } from '../src/features/project/schemas/projectPersistenceSchemas';
import type { EditorComponent } from './components';
import { expect, test } from './fixtures';

/**
 * Phase 4.1–4.2 — current-project timeline journeys.
 *
 * The deterministic retiming and transition matrices live below E2E. These
 * tests cover the two browser boundaries those suites cannot: loading and
 * editing the real writer-produced transition, and committing a pointer drag
 * onto a lane whose presentation axis is affected by a ripple adjustment.
 */

const TIMELINE_PATH = '.vloproject/timeline.json';

const TRANSITION_ID = 'transition_a43678d5-2a54-479e-8253-b5347ccea879';
const TRANSITION_OUTGOING_CLIP_ID =
    'clip_e4a2c13a-cb11-4bde-bbe9-2f257d9ec289';
const TRANSITION_TICK = 396_000;

const RIPPLE_ADJUSTMENT_ID = 'adj_65ebbd15-7100-4fae-8ebb-53101294fe91';
const RIPPLE_WINDOW_START = 1_734_000;
const RIPPLE_AFFECTED_CLIP_ID =
    'clip_acc0971a-8410-451f-a2c8-144357625662';
const EMPTY_TARGET_TRACK_ID = 'track_042d902b-572a-4b19-9b95-a6e5c6e3efd8';
const EMPTY_TARGET_TRACK_INDEX = 7;

function readTimeline(editor: EditorComponent) {
    return timelineDocumentSchema.parse(editor.fileSystem.readJson(TIMELINE_PATH));
}

async function waitForTimelineSave(editor: EditorComponent) {
    return editor.page.waitForResponse(
        (response) =>
            response.request().method() === 'PUT' &&
            new URL(response.url()).pathname.endsWith(
                `/__mock-fs/${TIMELINE_PATH}`,
            ) &&
            response.status() === 204,
    );
}

/**
 * Move a timeline clip vertically while retaining its current presentation x.
 * The target is the centre of a concrete row, avoiding dnd-kit's interstitial
 * track-insertion bands at row boundaries.
 */
async function dragClipToTrack(
    editor: EditorComponent,
    clipId: string,
    targetTrackIndex: number,
) {
    const { page, timeline } = editor;
    const source = timeline.getClipById(clipId);
    const target = timeline.rows.nth(targetTrackIndex);
    // The rich fixture has more lanes than the timeline viewport can show.
    // Bring the source lane fully into view before reading either geometry;
    // the empty target lane is immediately below it.
    await source.scrollIntoViewIfNeeded();
    await target.scrollIntoViewIfNeeded();
    const sourceBox = await source.boundingBox();
    const targetBox = await target.boundingBox();
    const viewportBox = await page
        .getByTestId('timeline-scroll-container')
        .boundingBox();
    if (!sourceBox || !targetBox || !viewportBox) {
        throw new Error('Could not resolve clip/track geometry for timeline drag');
    }

    // Rows are as wide as the entire scroll content, so their bounding-box x
    // may be far off-screen after seeking. Retain the visible clip x and use
    // only the target row's y; this also keeps the placement in the nested
    // adjustment window.
    const visibleLeft = Math.max(sourceBox.x, viewportBox.x + 90);
    const visibleRight = Math.min(
        sourceBox.x + sourceBox.width,
        viewportBox.x + viewportBox.width,
    );
    if (visibleRight - visibleLeft < 24) {
        throw new Error('Clip has no usable visible drag surface');
    }
    const sourceX = visibleLeft + (visibleRight - visibleLeft) / 2;
    const sourceY = sourceBox.y + sourceBox.height / 2;
    const targetY = targetBox.y + targetBox.height / 2;
    await page.mouse.move(sourceX, sourceY);
    await page.mouse.down();
    await page.waitForTimeout(120);
    await page.mouse.move(sourceX + 20, sourceY + 8, { steps: 8 });
    await page.mouse.move(sourceX, targetY, { steps: 20 });
    await page.waitForTimeout(200);
    await page.mouse.up();
}

test.describe('Current-project timeline', () => {
    test('transition edit survives reopen and deleting a linked clip prunes it', async ({
        editorCurrent,
    }) => {
        const editor = editorCurrent;
        const { page, timeline } = editor;

        await timeline.seekToTick(TRANSITION_TICK);
        const overlay = page.getByTestId(`transition-overlay-${TRANSITION_ID}`);
        await expect(overlay).toBeVisible();
        await overlay.click();

        await expect(page.getByText('Dissolve', { exact: true })).toBeVisible();
        const easing = page.getByRole('combobox').last();
        await expect(easing).toContainText('Ease in/out');

        const savedAfterEdit = waitForTimelineSave(editor);
        await easing.click();
        await page.getByRole('option', { name: 'Linear', exact: true }).click();
        await savedAfterEdit;
        expect(readTimeline(editor).transitions[0]?.parameters.easing).toBe(
            'linear',
        );

        await editor.reopenProject();
        await timeline.seekToTick(TRANSITION_TICK);
        await page.getByTestId(`transition-overlay-${TRANSITION_ID}`).click();
        await expect(page.getByRole('combobox').last()).toContainText('Linear');

        // Click the clip's non-overlapped leading edge; the transition overlay
        // intentionally owns pointer events over the trailing overlap.
        const outgoing = timeline.getClipById(TRANSITION_OUTGOING_CLIP_ID);
        const outgoingBox = await outgoing.boundingBox();
        if (!outgoingBox) throw new Error('Outgoing transition clip not visible');
        await outgoing.click({
            position: { x: 8, y: Math.max(4, outgoingBox.height / 2) },
        });
        const savedAfterDelete = waitForTimelineSave(editor);
        await timeline.deleteSelected();
        await savedAfterDelete;

        await expect(
            page.getByTestId(`transition-overlay-${TRANSITION_ID}`),
        ).toHaveCount(0);
        expect(readTimeline(editor).transitions).toHaveLength(0);
    });

    test('cold-opens ripple mode and preserves a cross-track move after reopen', async ({
        editorCurrent,
    }) => {
        const editor = editorCurrent;
        const { page, timeline, transformationPanel } = editor;

        await timeline.seekToTick(RIPPLE_WINDOW_START);
        await timeline.clickClipById(RIPPLE_ADJUSTMENT_ID);

        const rippleToggle = transformationPanel.adjustmentDepthSection.getByRole(
            'switch',
            { name: 'Ripple timeline timing' },
        );
        await expect(rippleToggle).toBeChecked();
        await expect(
            transformationPanel.adjustmentDepthSection.getByText(
                /later clips shift in presentation time/i,
            ),
        ).toBeVisible();

        const savedAfterMove = waitForTimelineSave(editor);
        await dragClipToTrack(
            editor,
            RIPPLE_AFFECTED_CLIP_ID,
            EMPTY_TARGET_TRACK_INDEX,
        );
        await savedAfterMove;

        const moved = readTimeline(editor).clips.find(
            (clip) => clip.id === RIPPLE_AFFECTED_CLIP_ID,
        );
        expect(moved?.trackId).toBe(EMPTY_TARGET_TRACK_ID);

        await editor.reopenProject();
        await timeline.seekToTick(RIPPLE_WINDOW_START);
        await expect(timeline.getClipById(RIPPLE_AFFECTED_CLIP_ID)).toBeVisible();
        const reopened = readTimeline(editor).clips.find(
            (clip) => clip.id === RIPPLE_AFFECTED_CLIP_ID,
        );
        expect(reopened?.trackId).toBe(EMPTY_TARGET_TRACK_ID);
    });
});
