import { test, expect } from './fixtures';
import { installApiMock } from './mocks/apiMock';
import { installWebSocketMock, simulateWsEvent, simulateGenerationComplete } from './mocks/websocketMock';

test.describe('Generation Panel', () => {

    test('Connection chip shows connected status', async ({ page }) => {
        // Install mocks before navigation
        await installWebSocketMock(page);
        await installApiMock(page, {
            runtimeStatus: { comfyui: { status: 'connected' } },
        });

        // Set up editor with default project
        const { EditorComponent } = await import('./components');
        const editor = new EditorComponent(page);
        await editor.setup();

        const { generationPanel } = editor;
        await expect(generationPanel.connectionChip).toBeVisible();
        await expect(generationPanel.connectionChip).toHaveText('ComfyUI connected');
    });

    test('Connection chip shows disconnected status', async ({ page }) => {
        await installWebSocketMock(page);
        await installApiMock(page, {
            runtimeStatus: { comfyui: { status: 'disconnected', error: null } },
        });

        const { EditorComponent } = await import('./components');
        const editor = new EditorComponent(page);
        await editor.setup();

        const { generationPanel } = editor;
        await expect(generationPanel.connectionChip).toBeVisible();
        await expect(generationPanel.connectionChip).toHaveText('ComfyUI disconnected');
    });

    test('Workflow selector lists available workflows', async ({ page }) => {
        await installWebSocketMock(page);
        await installApiMock(page, {
            workflowList: [
                { id: 'wf_a', name: 'Workflow Alpha' },
                { id: 'wf_b', name: 'Workflow Beta' },
                { id: 'wf_c', name: 'Workflow Charlie' },
            ],
        });

        const { EditorComponent } = await import('./components');
        const editor = new EditorComponent(page);
        await editor.setup();

        const { generationPanel } = editor;
        await expect(generationPanel.workflowSelect).toBeVisible();

        // Open the select dropdown
        await generationPanel.workflowSelect.click();

        // Verify all three workflows are listed
        await expect(page.getByRole('option', { name: 'Workflow Alpha' })).toBeVisible();
        await expect(page.getByRole('option', { name: 'Workflow Beta' })).toBeVisible();
        await expect(page.getByRole('option', { name: 'Workflow Charlie' })).toBeVisible();
    });

    test('Generate button disabled without connected backend', async ({ page }) => {
        await installWebSocketMock(page);
        await installApiMock(page, {
            runtimeStatus: { comfyui: { status: 'disconnected', error: null } },
        });

        const { EditorComponent } = await import('./components');
        const editor = new EditorComponent(page);
        await editor.setup();

        const { generationPanel } = editor;
        await expect(generationPanel.generateButton).toBeVisible();
        await expect(generationPanel.generateButton).toBeDisabled();
    });

    test('Generate happy path with progress', async ({ page }) => {
        await installWebSocketMock(page);
        await installApiMock(page, {
            promptResponse: {
                prompt_id: 'test-prompt-001',
                number: 1,
                node_errors: {},
            },
        });

        const { EditorComponent } = await import('./components');
        const editor = new EditorComponent(page);
        await editor.setup();

        const { generationPanel } = editor;

        // Generate button should be enabled with connected backend + workflow
        await expect(generationPanel.generateButton).toBeVisible();
        await expect(generationPanel.generateButton).toHaveText('Generate');

        // Wait for workflow to load (button becomes enabled)
        await expect(generationPanel.generateButton).toBeEnabled({ timeout: 10000 });

        // Click generate
        await generationPanel.clickGenerate();

        // Should show cancel button while running
        await expect(generationPanel.generateButton).toHaveText('Cancel');

        // Simulate progress events
        await simulateWsEvent(page, 'executing', {
            node: '3',
            prompt_id: 'test-prompt-001',
        });

        await simulateWsEvent(page, 'progress', {
            value: 50,
            max: 100,
            prompt_id: 'test-prompt-001',
            node: '3',
        });

        // Progress bar should appear
        await expect(generationPanel.progressBar).toBeVisible();

        // Complete generation
        await simulateGenerationComplete(page, 'test-prompt-001', '4', 'output_001.webp');
    });

    test('Cancel generation', async ({ page }) => {
        await installWebSocketMock(page);
        await installApiMock(page);

        const { EditorComponent } = await import('./components');
        const editor = new EditorComponent(page);
        await editor.setup();

        const { generationPanel } = editor;

        // Wait for workflow to load so button is enabled
        await expect(generationPanel.generateButton).toBeEnabled({ timeout: 10000 });

        // Start generation
        await generationPanel.clickGenerate();

        // Button should change to Cancel
        await expect(generationPanel.generateButton).toHaveText('Cancel');

        // Click cancel
        await generationPanel.clickCancel();

        // Button should revert to Generate
        await expect(generationPanel.generateButton).toHaveText('Generate', { timeout: 5000 });
    });

});
