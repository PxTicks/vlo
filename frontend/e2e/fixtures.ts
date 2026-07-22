import { expect, test as base } from '@playwright/test';
import { EditorComponent } from './components';
import { installApiMock } from './mocks/apiMock';
import { installWebSocketMock } from './mocks/websocketMock';

const ALLOWED_CONSOLE_ERRORS = [
    /favicon\.ico/i,
    /Failed to load resource: the server responded with a status of 404/i,
    // Reloading an open media project aborts in-flight range reads. Mediabunny
    // reports the expected cancellation before the old document is discarded.
    /Error while reading response stream\. Attempting to resume/i,
    /Retrying failed fetch\. Error: TypeError: Failed to fetch/i,
    // Reloading an open project (e.g. specs that return to the launcher) aborts
    // the editor's in-flight asset-directory listing. `Failed to fetch` only
    // ever means an aborted request in the mock filesystem — a live route
    // returns a status code — so this stays scoped to the abort, not a genuine
    // listing failure.
    /Failed to list directory .*Failed to fetch/i,
];

async function setupEditor(
    editor: EditorComponent,
    options: Parameters<EditorComponent['setup']>[0] = {},
) {
    await installWebSocketMock(editor.page);
    await installApiMock(editor.page);
    await editor.setup(options);
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
    /** Editor with the real current-format project — the default for new coverage. */
    editorCurrent: EditorComponent;
    /** Current-format project alias for mask and mask-composition coverage. */
    editorWithMasks: EditorComponent;
    /** Editor opened from the legacy single-document project fixture. */
    legacyEditor: EditorComponent;
    /** An EditorComponent instance without project setup — for tests that need the landing page. */
    editorNoSetup: EditorComponent;
    diagnostics: void;
}>({
    diagnostics: [
        async ({ page }, runFixture, testInfo) => {
            const errors: string[] = [];
            page.on('pageerror', (error) => {
                errors.push(`pageerror: ${error.stack ?? error.message}`);
            });
            page.on('console', (message) => {
                if (message.type() !== 'error') return;
                const text = message.text();
                if (ALLOWED_CONSOLE_ERRORS.some((pattern) => pattern.test(text))) {
                    return;
                }
                errors.push(`console.error: ${text}`);
            });
            page.on('response', (response) => {
                if (response.status() < 400) return;
                if (/\/favicon\.ico(?:\?|$)/i.test(response.url())) return;
                if (
                    response.status() === 404 &&
                    response.url().includes('/__mock-fs/')
                ) {
                    return;
                }
                errors.push(
                    `http ${response.status()}: ${response.request().method()} ${response.url()}`,
                );
            });

            await runFixture();

            if (errors.length > 0) {
                await testInfo.attach('browser-errors.txt', {
                    body: errors.join('\n\n'),
                    contentType: 'text/plain',
                });
            }
            if (testInfo.status === testInfo.expectedStatus) {
                expect(errors, 'Unexpected browser errors').toEqual([]);
            }
        },
        { auto: true },
    ],

    editor: async ({ page }, runFixture) => {
        const editor = new EditorComponent(page);
        await setupEditor(editor);
        await runFixture(editor);
    },

    editorWithClips: async ({ page }, runFixture) => {
        const editor = new EditorComponent(page);
        await setupEditor(editor, { fixtureDir: 'project_v2_with_clips' });
        await runFixture(editor);
    },

    editorWithAudioTrack: async ({ page }, runFixture) => {
        const editor = new EditorComponent(page);
        await setupEditor(editor, { fixtureDir: 'project_v3_with_audio_track' });
        await runFixture(editor);
    },

    editorCurrent: async ({ page }, runFixture) => {
        const editor = new EditorComponent(page);
        await setupEditor(editor, { fixtureDir: 'project_current' });
        await runFixture(editor);
    },

    editorWithMasks: async ({ page }, runFixture) => {
        const editor = new EditorComponent(page);
        await setupEditor(editor, { fixtureDir: 'project_current' });
        await runFixture(editor);
    },

    legacyEditor: async ({ page }, runFixture) => {
        const editor = new EditorComponent(page);
        await setupEditor(editor, {
            fixtureDir: 'project_v2_with_clips',
            projectFormat: 'legacy',
        });
        await runFixture(editor);
    },

    editorNoSetup: async ({ page }, runFixture) => {
        const editor = new EditorComponent(page);
        await runFixture(editor);
    },
});

export { expect };
