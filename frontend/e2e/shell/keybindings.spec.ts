import { test, expect } from '../fixtures';
import type { EditorComponent } from '../components';

/**
 * Phase 3.3 of docs/e2e-coverage-plan.md — focus-region gating.
 *
 * `timeline.spec.ts` already drives the happy path for these chords. What was
 * untested is the negative case that `useEditorFocusStore` exists to arbitrate:
 * region-scoped bindings (`Delete`, `Backspace`, `Mod+C`, `Mod+V` are declared
 * with `regions: ["timeline"]` in `features/timeline/hostCommands.ts`) must not
 * fire while another surface owns the keyboard. Unscoped bindings such as
 * undo/redo must keep working regardless — that contrast is what proves the
 * mechanism discriminates rather than blanket-swallowing keys.
 */
test.describe('Shell keybindings — focus region gating', () => {
    /** Moves keyboard ownership off the timeline into a text input. */
    async function focusProjectTitleInput(editor: EditorComponent) {
        await editor.page.getByTestId('project-title-display').click();
        const input = editor.page
            .getByTestId('project-title-input')
            .locator('input');
        await input.waitFor({ state: 'visible' });
        return input;
    }

    test('@smoke Delete does not reach the timeline while a text input has focus', async ({
        editorWithClips,
    }) => {
        const { timeline, page } = editorWithClips;

        await timeline.clickClip(0);
        const clipsBefore = await timeline.clips.count();

        await focusProjectTitleInput(editorWithClips);
        await page.keyboard.press('Delete');
        await page.keyboard.press('Backspace');

        // The clip must survive: the timeline does not own the keyboard.
        await expect(timeline.clips).toHaveCount(clipsBefore);
    });

    test('Delete reaches the timeline once it owns the keyboard again', async ({
        editorWithClips,
    }) => {
        const { timeline, page } = editorWithClips;

        await timeline.clickClip(0);
        const clipsBefore = await timeline.clips.count();

        // Take focus away, then hand it back by re-selecting in the timeline.
        await focusProjectTitleInput(editorWithClips);
        await page.keyboard.press('Escape');
        await timeline.clickClip(0);

        await page.keyboard.press('Delete');
        await expect(timeline.clips).toHaveCount(clipsBefore - 1);
    });

    test('region-scoped copy/paste does not duplicate clips from a text input', async ({
        editorWithClips,
    }) => {
        const { timeline, page } = editorWithClips;

        await timeline.clickClip(0);
        const clipsBefore = await timeline.clips.count();

        await focusProjectTitleInput(editorWithClips);
        await page.keyboard.press('Control+c');
        await page.keyboard.press('Control+v');

        await expect(timeline.clips).toHaveCount(clipsBefore);
    });

    test('the editable-target guard suppresses even unscoped chords', async ({
        editorWithClips,
    }) => {
        const { timeline, page } = editorWithClips;

        await timeline.clickClip(0);
        const clipsBefore = await timeline.clips.count();
        await timeline.deleteSelected();
        await expect(timeline.clips).toHaveCount(clipsBefore - 1);

        // Undo carries no region, but `isEditableTarget` is checked before any
        // region logic (core/shell/keybindingRegistry.ts:270), so text fields
        // suppress every host chord. Ctrl+Z belongs to the input, not the
        // timeline, while typing.
        await focusProjectTitleInput(editorWithClips);
        await page.keyboard.press('Control+z');
        await expect(timeline.clips).toHaveCount(clipsBefore - 1);
    });

    test('unscoped chords still fire from a non-editable, non-timeline region', async ({
        editorWithClips,
    }) => {
        const { timeline, page } = editorWithClips;

        await timeline.clickClip(0);
        const clipsBefore = await timeline.clips.count();
        await timeline.deleteSelected();
        await expect(timeline.clips).toHaveCount(clipsBefore - 1);

        // Hand the keyboard to the player: not editable, but not the timeline
        // either. Region-scoped Delete must stay suppressed while unscoped undo
        // applies — the contrast that proves gating discriminates by region
        // rather than blanket-swallowing keys.
        await page.getByTestId('player-canvas-container').click();

        await page.keyboard.press('Delete');
        await expect(timeline.clips).toHaveCount(clipsBefore - 1);

        await page.keyboard.press('Control+z');
        await expect(timeline.clips).toHaveCount(clipsBefore);
    });
});
