import { test as base } from '@playwright/test';
import { EditorComponent } from './components';
import { installApiMock } from './mocks/apiMock';
import { installWebSocketMock } from './mocks/websocketMock';

async function setupEditor(editor: EditorComponent, fixtureDir?: string) {
    await installWebSocketMock(editor.page);
    await installApiMock(editor.page);
    await editor.setup(fixtureDir);
}

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
    editor: async ({ page }, runFixture) => {
        const editor = new EditorComponent(page);
        await setupEditor(editor);
        await runFixture(editor);
    },

    editorWithClips: async ({ page }, runFixture) => {
        const editor = new EditorComponent(page);
        await setupEditor(editor, 'project_v2_with_clips');
        await runFixture(editor);
    },

    editorWithAudioTrack: async ({ page }, runFixture) => {
        const editor = new EditorComponent(page);
        await setupEditor(editor, 'project_v3_with_audio_track');
        await runFixture(editor);
    },

    editorNoSetup: async ({ page }, runFixture) => {
        const editor = new EditorComponent(page);
        await runFixture(editor);
    },
});

export { expect } from '@playwright/test';
