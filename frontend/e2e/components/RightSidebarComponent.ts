import { Page, Locator } from '@playwright/test';

type SidebarTab = 'Generate' | 'Adjust' | 'Transform' | 'Mask';

/** Sections of the Adjust tab, which owns a clip's built-in properties. */
export type AdjustSection = 'Display' | 'Speed' | 'Audio' | 'Color';

export const ADJUST_SECTIONS: readonly AdjustSection[] = [
    'Display',
    'Speed',
    'Audio',
    'Color',
];

// Test IDs derive from the shell view registry: RightSidebarPanel renders
// `right-sidebar-tab-${view.id}` with the `host.` prefix stripped, so these must
// track the IDs declared in app/layout/rightSidebarHostViews.ts.
//
// `host.adjust` ("Adjust") owns a clip's built-in properties; `host.effects`
// ("Transform") owns effects the user has added.
const TAB_TESTIDS: Record<SidebarTab, string> = {
    Generate: 'right-sidebar-tab-generate',
    Adjust: 'right-sidebar-tab-adjust',
    Transform: 'right-sidebar-tab-effects',
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

    /**
     * A section tab within the Adjust panel (Display / Speed / Audio / Color).
     * Scoped to the panel because these names are not globally unique — "Audio"
     * also matches the asset browser's type filter tab.
     */
    getAdjustSection(name: AdjustSection): Locator {
        return this.page
            .getByTestId('adjust-panel')
            .getByRole('tab', { name, exact: true });
    }

    async switchToAdjustSection(name: AdjustSection) {
        await this.switchToTab('Adjust');
        await this.getAdjustSection(name).click();
    }
}
