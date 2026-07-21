import { Page, Locator } from '@playwright/test';

type SidebarTab = 'Generate' | 'Transform' | 'Mask';

// Test IDs derive from the shell view registry: RightSidebarPanel renders
// `right-sidebar-tab-${view.id}` with the `host.` prefix stripped, so these must
// track the IDs declared in app/layout/rightSidebarHostViews.ts.
const TAB_TESTIDS: Record<SidebarTab, string> = {
    Generate: 'right-sidebar-tab-generate',
    Transform: 'right-sidebar-tab-transformations',
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
