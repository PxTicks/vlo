import { expect, test } from './fixtures';

/**
 * Distance-field mask edges in real WebGL (docs/mask-distance-field-plan.md).
 *
 * The probe paints binary coverage, shapes it through the production
 * renderer and reads it back. Grow must be exact pixels in both directions,
 * thin features must fatten rather than vanish or stripe, gaps must close at
 * exactly twice the grow, and feathers must follow their ramps.
 */

interface MaskDistanceFieldProbeResult {
    straightEdge: { growPx: number; measuredPx: number }[];
    thinLines: { lineWidth: number; growPx: number; coveredPx: number; runs: number }[];
    gap: { growPx: number; minGapCoverage: number }[];
    featherRamps: { mode: string; amountPx: number; maxError: number; monotonic: boolean }[];
    diagonal: { rmsError: number; maxError: number };
    largeReach: { areaRatio: number };
    wideTexture: { growPx: number; measuredPx: number };
    uniform: { emptyMax: number; fullMin: number };
}

test.describe('mask distance-field edges', () => {
    test('grows, shrinks and feathers by exact distances', async ({ editorCurrent }, testInfo) => {
        test.setTimeout(120_000);
        const page = editorCurrent.page;

        await expect
            .poll(() =>
                page.evaluate(() => typeof window.__vloE2E?.runMaskDistanceFieldProbe),
            )
            .toBe('function');

        const outcome = await page.evaluate(async () => {
            try {
                const result = await window.__vloE2E?.runMaskDistanceFieldProbe?.();
                return { ok: true as const, result };
            } catch (error) {
                return { ok: false as const, error: String(error) };
            }
        });
        if (!outcome.ok) throw new Error(outcome.error);
        const result = outcome.result as MaskDistanceFieldProbeResult;
        await testInfo.attach('mask-distance-field-summary.json', {
            body: JSON.stringify(result, null, 2),
            contentType: 'application/json',
        });

        for (const { growPx, measuredPx } of result.straightEdge) {
            expect(measuredPx, `straight edge grown ${growPx} px`).toBeCloseTo(growPx, 0);
            expect(Math.abs(measuredPx - growPx), `straight edge grown ${growPx} px`).toBeLessThanOrEqual(0.15);
        }

        // A 1 px line has no interior once its boundary is placed between
        // pixel steps, so it grows from its centre line: 2G wide. Wider
        // lines keep their width: 2G + w.
        for (const line of result.thinLines) {
            const expectedWidth = line.lineWidth === 1 ? 2 * line.growPx : 2 * line.growPx + line.lineWidth;
            const label = `${line.lineWidth} px line grown ${line.growPx} px`;
            expect(line.runs, label).toBe(1);
            expect(Math.abs(line.coveredPx - expectedWidth), label).toBeLessThanOrEqual(0.5);
        }

        const [open, closed] = result.gap;
        expect(open.minGapCoverage, `20 px gap grown ${open.growPx} px`).toBeLessThan(0.05);
        expect(closed.minGapCoverage, `20 px gap grown ${closed.growPx} px`).toBeGreaterThan(0.95);

        for (const ramp of result.featherRamps) {
            const label = `${ramp.mode} feather ${ramp.amountPx} px`;
            expect(ramp.monotonic, label).toBe(true);
            expect(ramp.maxError, label).toBeLessThanOrEqual(0.02);
        }

        expect(result.diagonal.rmsError, 'diagonal staircase grown 1 px').toBeLessThanOrEqual(0.05);
        expect(result.diagonal.maxError, 'diagonal staircase grown 1 px').toBeLessThanOrEqual(0.15);

        expect(result.largeReach.areaRatio).toBeGreaterThan(0.99);
        expect(result.largeReach.areaRatio).toBeLessThan(1.01);

        expect(Math.abs(result.wideTexture.measuredPx - result.wideTexture.growPx)).toBeLessThanOrEqual(0.15);

        expect(result.uniform.emptyMax).toBe(0);
        expect(result.uniform.fullMin).toBe(1);
    });
});
