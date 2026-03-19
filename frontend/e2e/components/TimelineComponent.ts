import { Page, Locator, expect } from '@playwright/test';

/**
 * Component Object Model for the Timeline.
 * Wraps: TimelineContainer.tsx, TimelineToolbar.tsx, TimelineRow.tsx, TimelineClip.tsx, TimelineRuler.tsx
 */
export class TimelineComponent {
    readonly page: Page;
    readonly toolbar: Locator;
    readonly ruler: Locator;
    readonly body: Locator;

    constructor(page: Page) {
        this.page = page;
        this.toolbar = page.getByTestId('timeline-toolbar');
        this.ruler = page.getByTestId('timeline-ruler');
        this.body = page.getByTestId('timeline-body').first();
    }

    get clips() {
        return this.page.getByTestId('timeline-clip');
    }

    get rows() {
        return this.page.getByTestId('timeline-row');
    }

    get snappingToggle() {
        return this.page.getByTestId('timeline-snapping-toggle');
    }

    get splitButton() {
        return this.toolbar.getByRole('button', { name: 'Split Clip (Cut)' });
    }

    get snapIndicator() {
        return this.page.getByTestId('timeline-snap-indicator');
    }

    async getClipCount(): Promise<number> {
        return this.clips.count();
    }

    getClip(index: number): Locator {
        return this.clips.nth(index);
    }

    async clickClip(index: number) {
        await this.clips.nth(index).click();
    }

    async deselectAll() {
        // Click an empty area of the timeline body to deselect
        await this.body.click({ position: { x: 20, y: 20 } });
    }

    async splitAtPlayhead() {
        await this.splitButton.click();
    }

    async toggleSnapping() {
        await this.snappingToggle.click();
    }

    /**
     * Keyboard shortcuts that operate on the timeline.
     * The timeline keyboard handler listens on window, so no focus management needed.
     */
    async pressKey(key: string) {
        await this.page.keyboard.press(key);
    }

    async deleteSelected() {
        await this.pressKey('Delete');
    }

    async undo() {
        await this.pressKey('Control+z');
    }

    async redo() {
        await this.pressKey('Control+Shift+z');
    }

    async copy() {
        await this.pressKey('Control+c');
    }

    async paste() {
        await this.pressKey('Control+v');
    }

    /**
     * Click on the timeline ruler at a proportional x position to seek the playhead.
     * @param xFraction 0.0 = left edge, 1.0 = right edge
     */
    async clickRulerAt(xFraction: number) {
        const box = await this.ruler.boundingBox();
        if (!box) throw new Error('Timeline ruler not found');
        const x = box.x + box.width * xFraction;
        const y = box.y + box.height / 2;
        await this.page.mouse.click(x, y);
    }
}
