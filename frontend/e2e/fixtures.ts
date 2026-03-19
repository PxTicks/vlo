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
    /** An EditorComponent instance without project setup — for tests that need the landing page. */
    editorNoSetup: EditorComponent;
}>({
    editor: async ({ page }, use) => {
        const editor = new EditorComponent(page);
        await editor.setup();
        await use(editor);
    },

    editorNoSetup: async ({ page }, use) => {
        const editor = new EditorComponent(page);
        await use(editor);
    },
});

export { expect } from '@playwright/test';
