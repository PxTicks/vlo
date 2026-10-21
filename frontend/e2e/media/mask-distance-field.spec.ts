import { expect, test } from './fixtures';

/**
 * Distance-field mask edges in real WebGL (docs/mask-distance-field-plan.md).
 *
 * The probe paints binary coverage, shapes it through the production
 * renderer and reads it back. Grow must be exact pixels in both directions,
 * thin features must fatten rather than vanish or stripe, gaps must close at
 * exactly twice the grow, and feathers must follow their ramps. A
 * distance-band asset must decode and shape to its exact sub-pixel edge.
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
    distanceBand: { label: string; rmsError: number; maxError: number }[];
    spriteBorder: { floodedArea: number; directArea: number; exactArea: number };
    nonUniformScale: { growAlongX: number; growAlongY: number };
}

test.describe('mask distance-field edges', () => {
    test('preserves sub-pixel boolean edges and removes internal seams', async ({ editorCurrent }, testInfo) => {
        const page = editorCurrent.page;
        await expect.poll(() => page.evaluate(() => typeof window.__vloE2E?.runMaskCompositeFieldProbe)).toBe('function');
        const result = await page.evaluate(async () => {
            const run = window.__vloE2E?.runMaskCompositeFieldProbe;
            if (!run) throw new Error('Composite field probe missing');
            return await run() as {
                subpixel: { label: string; rmsError: number; maxError: number }[];
                crossings: { label: string; rmsError: number; maxError: number; junctionMaxError: number; sampleLineJunctionError: number; junctionSamples: number; edgeSamples: number }[];
                seams: { label: string; minimum: number }[];
                identities: { label: string; maxError: number }[];
                erasedFeatureArea: number;
                binaryFieldMaxError: number;
                singleBrushMaxError: number;
                brushGrowMaxError: number;
                transformed: { label: string; measured: number; expected: number; tolerance: number }[];
            };
        });
        await testInfo.attach('mask-composite-field-summary.json', {
            body: JSON.stringify(result, null, 2), contentType: 'application/json',
        });
        expect(result.subpixel).toHaveLength(7);
        for (const edge of result.subpixel) {
            expect(edge.rmsError, edge.label).toBeLessThanOrEqual(0.02);
            expect(edge.maxError, edge.label).toBeLessThanOrEqual(0.15);
        }
        expect(result.crossings).toHaveLength(6);
        for (const corner of result.crossings) {
            expect(corner.edgeSamples, corner.label).toBeGreaterThan(0);
            expect(corner.junctionSamples, corner.label).toBeGreaterThanOrEqual(4);
            expect(corner.rmsError, corner.label).toBeLessThanOrEqual(0.02);
            expect(corner.maxError, corner.label).toBeLessThanOrEqual(0.25);
            expect(corner.junctionMaxError, corner.label).toBeLessThanOrEqual(0.25);
            // Known 4-neighbour seeding limit when an edge runs through texel
            // centres: the corner texel misplaces its seed by up to half a
            // texel of coverage, but never takes the wrong sign (plan §6).
            expect(corner.sampleLineJunctionError, corner.label).toBeLessThanOrEqual(0.5);
        }
        for (const seam of result.seams) expect(seam.minimum, seam.label).toBe(1);
        for (const identity of result.identities) expect(identity.maxError, identity.label).toBeLessThanOrEqual(0.15);
        expect(result.erasedFeatureArea).toBe(0);
        expect(result.binaryFieldMaxError).toBeLessThanOrEqual(0.02);
        expect(result.singleBrushMaxError).toBeLessThanOrEqual(0.02);
        expect(result.brushGrowMaxError).toBeLessThanOrEqual(0.02);
        for (const item of result.transformed) {
            expect(Math.abs(item.measured - item.expected), item.label).toBeLessThanOrEqual(item.tolerance);
        }
    });

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

        // Distance-band (SAM2) masks shape from their own sub-pixel band: a
        // disc matches the exact result to within the band's 8-bit levels,
        // whether shaped in one pass or flooded from the band's zero crossing.
        expect(result.distanceBand.length).toBe(5);
        for (const band of result.distanceBand) {
            expect(band.rmsError, band.label).toBeLessThanOrEqual(0.01);
            expect(band.maxError, band.label).toBeLessThanOrEqual(0.15);
        }

        // A band drawn smaller than the content ends at the sprite border:
        // read directly it cannot grow past it (the control), flooded from
        // its edge it grows like any mask.
        const { spriteBorder } = result;
        expect(spriteBorder.directArea, 'band read directly').toBeLessThan(spriteBorder.exactArea * 0.7);
        expect(Math.abs(spriteBorder.floodedArea - spriteBorder.exactArea) / spriteBorder.exactArea).toBeLessThanOrEqual(0.005);

        // Under a non-uniform scale a 4 px grow is 4 px along both axes.
        expect(Math.abs(result.nonUniformScale.growAlongX - 4)).toBeLessThanOrEqual(0.3);
        expect(Math.abs(result.nonUniformScale.growAlongY - 4)).toBeLessThanOrEqual(0.3);
    });
});
