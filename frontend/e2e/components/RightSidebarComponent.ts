import { Page, Locator } from '@playwright/test';

type SidebarTab = 'Generate' | 'Transform' | 'Mask';

const TAB_TESTIDS: Record<SidebarTab, string> = {
    Generate: 'right-sidebar-tab-generate',
    Transform: 'right-sidebar-tab-transform',
    Mask: 'right-sidebar-tab-mask',
};

/**
 * Component Object Model for the Right Sidebar panel.
 * Wraps: RightSidebarPanel.tsx
 */
export class RightSidebarComponent {
    readonly page: Page;
    readonly tabs: Locator;

    constructor(page: Page) {
        this.page = page;
        this.tabs = page.getByTestId('right-sidebar-tabs');
    }

    getTab(name: SidebarTab): Locator {
        return this.page.getByTestId(TAB_TESTIDS[name]);
    }

    async switchToTab(name: SidebarTab) {
        await this.getTab(name).click();
    }

    async isTabVisible(name: SidebarTab): Promise<boolean> {
        return this.getTab(name).isVisible();
    }
}
