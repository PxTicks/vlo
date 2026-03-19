import { Page, Locator } from '@playwright/test';

type SidebarTab = 'Generate' | 'Transform' | 'Mask';

/**
 * Component Object Model for the Right Sidebar panel.
 * Wraps: RightSidebarPanel.tsx
 */
export class RightSidebarComponent {
    readonly page: Page;

    constructor(page: Page) {
        this.page = page;
    }

    getTab(name: SidebarTab): Locator {
        return this.page.getByRole('tab', { name });
    }

    async switchToTab(name: SidebarTab) {
        await this.getTab(name).click();
    }

    async isTabVisible(name: SidebarTab): Promise<boolean> {
        return this.getTab(name).isVisible();
    }
}
