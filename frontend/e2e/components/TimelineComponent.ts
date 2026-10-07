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

    get addAdjustmentButton() {
        return this.toolbar.getByTestId('timeline-toolbar-add-adjustment');
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

    /**
     * Address a clip by its stable model id (the `data-clip-id` attribute),
     * rather than by timeline position. Preferred for fixture-anchored specs
     * that need a specific pre-authored clip regardless of track ordering.
     */
    getClipById(clipId: string): Locator {
        return this.page.locator(`[data-clip-id="${clipId}"]`);
    }

    async clickClip(index: number) {
        await this.clips.nth(index).click();
    }

    async clickClipById(clipId: string) {
        await this.getClipById(clipId).click();
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

    async addAdjustmentClip() {
        await this.addAdjustmentButton.click();
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
     *
     * @deprecated The fraction spans the whole ruler *including* the sticky
     * `TRACK_HEADER_WIDTH` header region, which maps to tick 0, so a small
     * fraction on a narrow layout clamps to zero and does not seek. Prefer
     * {@link seekToTick} for anything that needs a known playhead position.
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
     * Seek the playhead to an exact project tick by clicking the ruler at the
     * position production maps that tick to, accounting for the header, zoom
     * and horizontal scroll. Scrolls the tick into view first when needed, then
     * asserts the resulting playhead landed on the requested tick.
     *
     * The tick must be frame-aligned: the ruler snaps every seek to the frame
     * grid, so a non-aligned tick can never be the landing position.
     *
     * @returns the playhead tick actually reached (equal to `tick` on success).
     */
    async seekToTick(tick: number): Promise<number> {
        const geometry = await this.page.evaluate((tickArg) => {
            const bridge = window.__vloE2E;
            if (!bridge) return null;
            return bridge.getTimelineTickGeometry(tickArg);
        }, tick);
        if (!geometry) {
            throw new Error(
                'seekToTick requires the E2E diagnostics bridge — is VITE_E2E_DIAGNOSTICS set for the dev server?',
            );
        }

        const scroller = this.page.getByTestId('timeline-scroll-container');

        // Bring the target within the visible band. Time 0 sits at
        // TRACK_HEADER_WIDTH inside the scroll content; keep a margin so the
        // click never lands on the sticky header seam. `ticksToPx` is
        // scroll-independent, so scrollLeft is the only variable to solve for.
        await scroller.evaluate(
            (element, { absolutePx, trackHeaderWidth }) => {
                const scrollElement = element as HTMLElement;
                const visibleWidth = scrollElement.clientWidth - trackHeaderWidth;
                const margin = Math.min(48, visibleWidth / 4);
                const leftEdge = scrollElement.scrollLeft;
                const rightEdge = leftEdge + visibleWidth;
                if (absolutePx < leftEdge + margin) {
                    scrollElement.scrollLeft = Math.max(0, absolutePx - margin);
                } else if (absolutePx > rightEdge - margin) {
                    scrollElement.scrollLeft = absolutePx - visibleWidth + margin;
                }
            },
            {
                absolutePx: geometry.absolutePx,
                trackHeaderWidth: geometry.trackHeaderWidth,
            },
        );

        // The `timeline-ruler` element is the full-width scroll *content*, so
        // its box left already moves with scroll — the scroll offset must NOT
        // be subtracted again. Page x of a tick is therefore just:
        //   rulerBox.x + TRACK_HEADER_WIDTH + ticksToPx(tick)
        // Read the box after scrolling so its shifted position is current.
        const rulerBox = await this.ruler.boundingBox();
        if (!rulerBox) throw new Error('Timeline ruler not found');
        const clickX =
            rulerBox.x + geometry.trackHeaderWidth + geometry.absolutePx;
        const clickY = rulerBox.y + rulerBox.height / 2;
        await this.page.mouse.click(clickX, clickY);

        return this.page.evaluate(
            () => window.__vloE2E?.getPlaybackDiagnostics().playheadTicks ?? -1,
        );
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
     * Returns the locator for a track header by row index.
     */
    getTrackHeader(rowIndex: number): Locator {
        return this.rows.nth(rowIndex).getByTestId('timeline-track-header');
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
