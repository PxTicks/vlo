import { expect, test } from './fixtures';

/**
 * Phase 5.4 — real baked-versus-live composite pixel parity.
 *
 * The live frame is extracted from the composite-scene texture before parent
 * timeline operations. The same local tick is rendered through the production
 * alpha-preserving bake path, captured immediately before encoding, then
 * decoded back through Mediabunny/Chromium. Only comparison summaries cross
 * the Playwright boundary; the three 1080p RGBA frames stay in the browser.
 */

const COMPOSITE_ID = 'composite_effce8c8-0ef9-4e17-8482-df81b50744d8';
// Sample comfortably inside the placement. Its exact stored start is also the
// boundary of the first frame, where decoder/source readiness can legitimately
// defer the live scene by one request.
const COMPOSITE_PLACEMENT_SAMPLE = 1_602_000;

interface PixelComparison {
    passed: boolean;
    dimensionsMatch: boolean;
    maxChannelDelta: number;
    meanAbsoluteChannelDelta: number;
    differentPixelRatio: number;
    differentPixelCount: number;
    pixelCount: number;
}

interface CompositeParityResult {
    liveVsPreEncode: PixelComparison;
    preEncodeVsDecoded: PixelComparison;
    width: number;
    height: number;
    localPresentationTick: number;
    encodedBytes: number;
    encodedType: string;
}

test.describe('composite pixel parity', () => {
    test('live, pre-encode and decoded-bake frames remain within repository tolerances', async ({
        editorCurrent,
    }, testInfo) => {
        test.setTimeout(180_000);
        const page = editorCurrent.page;

        await expect
            .poll(() =>
                page.evaluate(
                    () => typeof window.__vloE2E?.runCompositeParityProbe,
                ),
            )
            .toBe('function');

        // Put the real UI into live-source mode first. Besides covering the
        // supported override, this ensures Player has committed the source
        // policy before the diagnostic asks for a synchronous texture capture.
        await editorCurrent.leftSidebar.switchTo('Composite');
        const compositeCard = page.locator(
            `[data-testid="composite-card"][data-composite-id="${COMPOSITE_ID}"]`,
        );
        await expect(compositeCard).toBeVisible();
        const forceLive = compositeCard.getByRole('button', {
            name: 'Force live rendering',
        });
        await forceLive.click();
        await expect(
            compositeCard.getByRole('button', {
                name: 'Use automatic source policy',
            }),
        ).toHaveAttribute('aria-pressed', 'true');
        await editorCurrent.timeline.seekToTick(COMPOSITE_PLACEMENT_SAMPLE);

        const outcome = await page.evaluate(
            async ({ compositeId, placementTick }) => {
                try {
                    const result =
                        await window.__vloE2E?.runCompositeParityProbe?.({
                            compositeId,
                            placementTick,
                        });
                    return { ok: true as const, result };
                } catch (error) {
                    return { ok: false as const, error: String(error) };
                }
            },
            {
                compositeId: COMPOSITE_ID,
                placementTick: COMPOSITE_PLACEMENT_SAMPLE,
            },
        );

        if (!outcome.ok) {
            throw new Error(outcome.error);
        }
        const result = outcome.result as CompositeParityResult;
        await testInfo.attach('composite-parity-summary.json', {
            body: JSON.stringify(result, null, 2),
            contentType: 'application/json',
        });

        expect(result.width).toBeGreaterThan(0);
        expect(result.height).toBeGreaterThan(0);
        expect(result.encodedType).toBe('video/webm');
        expect(result.encodedBytes).toBeGreaterThan(0);

        expect(
            result.liveVsPreEncode.dimensionsMatch,
            'live and pre-encode dimensions differ',
        ).toBe(true);
        expect(
            result.liveVsPreEncode.passed,
            `live/pre-encode mismatch: ${JSON.stringify(result.liveVsPreEncode)}`,
        ).toBe(true);

        expect(
            result.preEncodeVsDecoded.dimensionsMatch,
            'pre-encode and decoded-bake dimensions differ',
        ).toBe(true);
        expect(
            result.preEncodeVsDecoded.passed,
            `pre-encode/decoded mismatch: ${JSON.stringify(result.preEncodeVsDecoded)}`,
        ).toBe(true);
    });
});
