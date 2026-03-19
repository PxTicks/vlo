import { Page, Locator } from '@playwright/test';

interface DragOptions {
    /**
     * Number of intermediate mouse-move steps for the initial activation move.
     * dnd-kit's PointerSensor requires a minimum drag distance (3px in this app)
     * before recognising a drag. We overshoot slightly to guarantee activation.
     * @default 8
     */
    activationSteps?: number;
    /** Number of intermediate steps from the activation point to the target. @default 20 */
    moveSteps?: number;
    /** Milliseconds to wait after mousedown before starting the activation move. @default 120 */
    preActivationDelay?: number;
    /** Milliseconds to wait at the target position before releasing. @default 200 */
    hoverDelay?: number;
    /** Pixel offset from source center for the activation move. @default 20 */
    activationOffset?: number;
}

const DEFAULTS: Required<DragOptions> = {
    activationSteps: 8,
    moveSteps: 20,
    preActivationDelay: 120,
    hoverDelay: 200,
    activationOffset: 20,
};

/**
 * Performs a drag operation from a source element to a target element.
 *
 * This is designed to work with dnd-kit, which requires a minimum pointer distance
 * before a drag is recognised. The helper performs a short "activation" move first
 * (to exceed the 3px threshold) before moving to the final target.
 */
export async function performDrag(
    page: Page,
    source: Locator,
    target: Locator,
    options?: DragOptions,
): Promise<void> {
    const opts = { ...DEFAULTS, ...options };

    const sourceBox = await source.boundingBox();
    const targetBox = await target.boundingBox();
    if (!sourceBox || !targetBox) {
        throw new Error('Could not find bounding box for source or target element');
    }

    const sourceX = sourceBox.x + sourceBox.width / 2;
    const sourceY = sourceBox.y + sourceBox.height / 2;
    const targetX = targetBox.x + Math.min(180, targetBox.width / 2);
    const targetY = targetBox.y + targetBox.height / 2;

    // 1. Hover over source and press mouse
    await page.mouse.move(sourceX, sourceY);
    await page.mouse.down();
    await page.waitForTimeout(opts.preActivationDelay);

    // 2. Small activation move to exceed dnd-kit's PointerSensor distance threshold
    await page.mouse.move(
        sourceX + opts.activationOffset,
        sourceY + opts.activationOffset,
        { steps: opts.activationSteps },
    );

    // 3. Move to target
    await page.mouse.move(targetX, targetY, { steps: opts.moveSteps });
    await page.waitForTimeout(opts.hoverDelay);

    // 4. Release
    await page.mouse.up();
}

/**
 * Drags an asset card from the asset browser onto the timeline.
 * This is an action-only helper — callers should assert the outcome separately.
 */
export async function dragAssetToTimeline(
    page: Page,
    assetName: string = 'A_woman_in_202601222322_bssr2mp4',
): Promise<void> {
    const assetCard = page.getByTestId('asset-card').filter({ hasText: assetName }).first();
    const trackBody = page.getByTestId('timeline-body').first();

    await performDrag(page, assetCard, trackBody);
}
