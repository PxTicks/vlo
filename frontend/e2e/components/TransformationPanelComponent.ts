import { Page, Locator } from '@playwright/test';
import { performDrag } from '../helpers/drag';

/**
 * Component Object Model for the Transformation Panel.
 * Wraps: TransformationPanel.tsx
 */
export class TransformationPanelComponent {
    readonly page: Page;
    /** The Adjust view: a clip's built-in Display/Speed/Audio/Color properties. */
    readonly adjustPanel: Locator;
    /** The Transform view: effects the user has added to the clip. */
    readonly effectsPanel: Locator;

    constructor(page: Page) {
        this.page = page;
        this.adjustPanel = page.getByTestId('adjust-panel');
        this.effectsPanel = page.getByTestId('effects-panel');
    }

    get libraryPanel() {
        return this.page.getByTestId('transformation-library-panel');
    }

    /**
     * Library cards are keyed by transform type (a filter's `filterName`, else
     * its `type`) — not by display label. Mirrors the dnd-kit draggable ID.
     */
    libraryCard(transformType: string) {
        return this.page.getByTestId(`transformation-card-${transformType}`);
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

    /**
     * Adds a transform by dragging its library card onto a timeline clip.
     *
     * The shell migration moved the effects library into the left sidebar and
     * replaced the old add-menu with a dnd-kit drag whose drop target is the
     * clip itself, so callers must supply the destination clip.
     */
    async addTransform(transformType: string, targetClip: Locator) {
        await this.libraryCard(transformType).waitFor({ state: 'visible' });
        await performDrag(this.page, this.libraryCard(transformType), targetClip);
    }
}
