import { Page, Locator } from '@playwright/test';

/**
 * Component Object Model for the Transformation Panel.
 * Wraps: TransformationPanel.tsx
 *
 * Note: Requires data-testid attributes to be added to TransformationPanel.tsx in Phase 6.
 * For now, uses role-based and text-based locators where possible.
 */
export class TransformationPanelComponent {
    readonly page: Page;

    constructor(page: Page) {
        this.page = page;
    }

    get addButton() {
        return this.page.getByRole('button', { name: 'Add Transformation' });
    }

    async addTransform(type: string) {
        await this.addButton.click();
        await this.page.getByRole('menuitem', { name: type }).click();
    }
}
