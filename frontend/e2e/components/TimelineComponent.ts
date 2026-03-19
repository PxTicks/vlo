import { Page, Locator } from '@playwright/test';

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
        // Click an empty area of the timeline body to deselect.
        // Use a far-right position to avoid clips that may overlay the body near the left edge.
        const box = await this.body.boundingBox();
        if (!box) throw new Error('Timeline body not found');
        const x = Math.max(10, Math.min(box.width - 10, 800));
        await this.body.click({ position: { x, y: 20 } });
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

    /**
     * Check whether a clip is selected via the semantic clip state attribute.
     */
    async isClipSelected(index: number): Promise<boolean> {
        const clip = this.getClip(index);
        return (await clip.getAttribute('data-selected')) === 'true';
    }

    getClipResizeHandle(index: number, side: 'left' | 'right'): Locator {
        return this.getClip(index).getByTestId(`timeline-clip-resize-handle-${side}`);
    }

    /**
     * Returns the locator for the visibility toggle on a track row by row index.
     */
    getTrackVisibilityToggle(rowIndex: number): Locator {
        return this.rows.nth(rowIndex).getByTestId('track-visibility-toggle');
    }

    /**
     * Returns the locator for the mute toggle on a track row by row index.
     */
    getTrackMuteToggle(rowIndex: number): Locator {
        return this.rows.nth(rowIndex).getByTestId('track-mute-toggle');
    }

    /**
     * Returns a clip locator filtered by text content (name).
     */
    getClipByName(name: string): Locator {
        return this.clips.filter({ hasText: name });
    }
}
