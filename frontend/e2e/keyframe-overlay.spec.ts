import { expect, test } from './fixtures';

/**
 * Keyframe diamonds on the timeline clip.
 *
 * Regression: the Adjust panel bundles layout/fit-mode/blend-mode into one
 * "Display" section whose id (`default:display`) names no transformation
 * definition, so the overlay resolved no groups and drew no diamonds for
 * position/scale/rotation keyframes. Speed is a single-definition section and
 * kept working, so both are asserted here — the pair pins the section-id
 * contract between the panel and `collectSectionKeyframes`.
 */
test.describe('Keyframe clip overlay', () => {
    const diamonds = (editor: import('./components').EditorComponent) =>
        editor.page.getByTestId('timeline-keyframe-diamond');

    async function toggleKeyframeAtPlayhead(
        editor: import('./components').EditorComponent,
        active: boolean,
    ) {
        await editor.transformationPanel.adjustPanel
            .getByRole('button', {
                name: active
                    ? 'Keyframe exists at playhead'
                    : 'Add keyframe at playhead',
            })
            .first()
            .click();
    }

    test('Display keyframes draw a diamond on the clip', async ({
        editorCurrent,
    }) => {
        const editor = editorCurrent;

        await editor.timeline.clickClip(0);
        await editor.rightSidebar.switchToAdjustSection('Display');
        await expect(editor.transformationPanel.adjustPanel).toBeVisible();
        await expect(diamonds(editor)).toHaveCount(0);

        await toggleKeyframeAtPlayhead(editor, false);
        await expect(diamonds(editor).first()).toBeVisible();

        // Removing the keyframe clears the marker again.
        await toggleKeyframeAtPlayhead(editor, true);
        await expect(diamonds(editor)).toHaveCount(0);
    });

    test('Speed keyframes draw a diamond on the clip', async ({
        editorCurrent,
    }) => {
        const editor = editorCurrent;

        await editor.timeline.clickClip(0);
        await editor.rightSidebar.switchToAdjustSection('Speed');
        await expect(editor.transformationPanel.adjustPanel).toBeVisible();

        await toggleKeyframeAtPlayhead(editor, false);
        await expect(diamonds(editor).first()).toBeVisible();
    });
});
