import { test as base } from '@playwright/test';
import { EditorComponent } from './components';

/**
 * Custom Playwright fixtures for VLO e2e tests.
 *
 * Usage:
 *   import { test, expect } from '../fixtures';
 *
 *   test('example', async ({ editor }) => {
 *     await editor.timeline.clickClip(0);
 *   });
 */
export const test = base.extend<{
    /** A fully set up EditorComponent with the default project loaded. */
    editor: EditorComponent;
    /** Editor with project_v2_with_clips — has 2 clips on the timeline. */
    editorWithClips: EditorComponent;
    /** Editor with project_v3_with_audio_track — has 2 video clips + 1 audio clip on 3 tracks. */
    editorWithAudioTrack: EditorComponent;
    /** An EditorComponent instance without project setup — for tests that need the landing page. */
    editorNoSetup: EditorComponent;
}>({
    editor: async ({ page }, use) => {
        const editor = new EditorComponent(page);
        await editor.setup();
        await use(editor);
    },

    editorWithClips: async ({ page }, use) => {
        const editor = new EditorComponent(page);
        await editor.setup('project_v2_with_clips');
        await use(editor);
    },

    editorWithAudioTrack: async ({ page }, use) => {
        const editor = new EditorComponent(page);
        await editor.setup('project_v3_with_audio_track');
        await use(editor);
    },

    editorNoSetup: async ({ page }, use) => {
        const editor = new EditorComponent(page);
        await use(editor);
    },
});

export { expect } from '@playwright/test';
