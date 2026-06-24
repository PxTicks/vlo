import { Page, Locator } from '@playwright/test';

/**
 * Component Object Model for the Transformation Panel.
 * Wraps: TransformationPanel.tsx
 */
export class TransformationPanelComponent {
    readonly page: Page;
    readonly panel: Locator;

    constructor(page: Page) {
        this.page = page;
        this.panel = page.getByTestId('transformation-panel');
    }

    get addButton() {
        return this.page.getByTestId('transformation-add-button');
    }

    get addMenu() {
        return this.page.getByTestId('transformation-add-menu');
    }

    get adjustmentDepthSection() {
        return this.page.getByTestId('adjustment-depth-section');
    }

    get effectMaskButtons() {
        return this.page.getByTestId(/^effect-mask-button-/);
    }

    get effectMaskDialog() {
        return this.page.getByTestId('effect-mask-dialog');
    }

    async addTransform(type: string) {
        await this.addButton.click();
        await this.page.getByRole('menuitem', { name: type, exact: true }).click();
    }
}
