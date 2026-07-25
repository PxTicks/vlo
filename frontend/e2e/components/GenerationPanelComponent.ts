import { Page } from '@playwright/test';

/**
 * Component Object Model for the Generation Panel.
 * Wraps: GenerationPanel.tsx
 */
export class GenerationPanelComponent {
    readonly page: Page;

    constructor(page: Page) {
        this.page = page;
    }

    get panel() {
        return this.page.getByTestId('generation-panel');
    }

    get connectionChip() {
        return this.page.getByTestId('generation-connection-chip');
    }

    /** The nested workflow menu shown until a workflow is chosen. */
    get workflowMenu() {
        return this.panel.getByLabel('Generation workflows');
    }

    /**
     * Workflows the menu has no placement for sit at its root, so a fixture
     * workflow is reachable without opening a folder.
     */
    workflowMenuItem(name: string) {
        return this.workflowMenu.getByRole('button', { name, exact: true });
    }

    get generateButton() {
        return this.page.getByTestId('generation-generate-button');
    }

    get progressBar() {
        return this.page.getByTestId('generation-progress-bar');
    }

    get cancelCurrentButton() {
        return this.panel.getByRole('button', { name: 'Cancel current generation' });
    }

    get sendToTimelineButton() {
        return this.page.getByTestId('generation-send-to-timeline-button');
    }

    async clickGenerate() {
        await this.generateButton.click();
    }

    async clickCancel() {
        await this.cancelCurrentButton.click();
    }

    async selectWorkflow(name: string) {
        await this.workflowMenuItem(name).click();
    }
}
