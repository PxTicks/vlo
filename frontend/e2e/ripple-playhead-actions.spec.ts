import { expect, test } from './fixtures';
import type { EditorComponent } from './components';

/**
 * Playhead-driven actions on a clip whose content is displaced by a ripple
 * retime.
 *
 * The current fixture already carries the hard case: `adj_65ebbd15` is a 2x
 * adjustment on Track 5 with `retimingMode: "ripple"` and depth "all", so the
 * 474000 stored ticks it covers are presented in 237000. Every clip below it
 * has its later content pulled 237000 ticks earlier on screen than its stored
 * timing says — `clip_6301d796` (stored 1548000..2448000) spans that boundary.
 *
 * Reading the playhead as stored time therefore mis-anchors anything created
 * from it. These specs assert at the pixel level, comparing the created marker
 * and the resulting cut against where the playhead is actually drawn, so they
 * fail on any regression in the presentation→stored/source conversions rather
 * than re-deriving the mapping the app itself uses.
 */

const RIPPLED_CLIP = 'clip_6301d796-0663-4254-9462-a0848e62357d';
/**
 * A frame-aligned tick (fps 16 → 6000 ticks/frame) inside the clip's
 * presentation footprint and past the ripple region, where the displacement is
 * the full 237000 ticks. The spec asserts the playhead really landed over the
 * clip, so this stays honest if the fixture shifts.
 */
const PLAYHEAD_TICK = 2100000;

/** Horizontal centre of a locator's box, in page coordinates. */
async function centreX(locator: import('@playwright/test').Locator) {
    const box = await locator.boundingBox();
    if (!box) throw new Error('element has no box');
    return box.x + box.width / 2;
}

async function seekOverRippledClip(editor: EditorComponent) {
    const landedTick = await editor.timeline.seekToTick(PLAYHEAD_TICK);
    expect(landedTick).toBe(PLAYHEAD_TICK);

    const clipBox = await editor.timeline.getClipById(RIPPLED_CLIP).boundingBox();
    if (!clipBox) throw new Error(`${RIPPLED_CLIP} is not rendered`);
    const playheadX = await centreX(editor.page.getByTestId('timeline-playhead'));

    // The whole point of the fixture: the playhead is drawn over this clip.
    expect(playheadX).toBeGreaterThan(clipBox.x);
    expect(playheadX).toBeLessThan(clipBox.x + clipBox.width);

    return { clipBox, playheadX };
}

test.describe('Playhead actions across a ripple retime', () => {
    test('a marker is drawn where the playhead created it', async ({
        editorCurrent,
    }) => {
        const editor = editorCurrent;
        const { playheadX } = await seekOverRippledClip(editor);

        const markers = editor.timeline
            .getClipById(RIPPLED_CLIP)
            .locator('[data-overlay-item-id^="clip-marker:"]');
        await expect(markers).toHaveCount(0);

        await editor.page.getByTestId('timeline-add-marker').click();

        // Anchored in source time and rendered back through the ripple: the
        // marker lands under the playhead, not 237000 ticks away from it.
        await expect(markers).toHaveCount(1);
        expect(Math.abs((await centreX(markers)) - playheadX)).toBeLessThanOrEqual(2);
    });

    test('a split cuts where the playhead is drawn', async ({
        editorCurrent,
    }) => {
        const editor = editorCurrent;
        const { playheadX } = await seekOverRippledClip(editor);

        const clipsBefore = await editor.timeline.getClipCount();
        await editor.timeline.splitAtPlayhead();

        // Passing the presentation tick straight to the model used to fail the
        // clip-bounds guard or cut at the wrong content frame; neither adds a
        // clip whose edge lines up with the playhead.
        await expect(editor.timeline.clips).toHaveCount(clipsBefore + 1);

        const leftBox = await editor.timeline
            .getClipById(RIPPLED_CLIP)
            .boundingBox();
        if (!leftBox) throw new Error('left piece is not rendered');
        expect(Math.abs(leftBox.x + leftBox.width - playheadX)).toBeLessThanOrEqual(2);
    });
});
