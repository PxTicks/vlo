export interface GradientBandingMetrics {
  readonly eightBitIntermediateLevels: number;
  readonly float16IntermediateLevels: number;
  readonly eightBitOutputLevels: number;
  readonly ditheredOutputLevels: number;
}

function uniqueCount(values: ArrayLike<number>): number {
  return new Set(Array.from(values, (value) => value)).size;
}

export function createGradientStressFixture(width = 4096): Float32Array {
  return Float32Array.from(
    { length: width },
    (_, index) => index / Math.max(1, width - 1),
  );
}

export function measureGradientBanding(
  source = createGradientStressFixture(),
): GradientBandingMetrics {
  const eightBit = Array.from(source, (value) => Math.round(value * 255) / 255);
  // Half floats retain roughly 10 mantissa bits around the normalized range.
  const float16 = Array.from(source, (value) => Math.round(value * 4095) / 4095);
  const compress = (value: number): number => value * 0.08 + 0.46;
  const output = eightBit.map((value) => Math.round(compress(value) * 255));
  const dithered = eightBit.map((value, index) => {
    const noise = (((index * 0.754877666) % 1) - 0.5) * 2;
    return Math.max(0, Math.min(255, Math.round(compress(value) * 255 + noise)));
  });
  return {
    eightBitIntermediateLevels: uniqueCount(eightBit),
    float16IntermediateLevels: uniqueCount(float16),
    eightBitOutputLevels: uniqueCount(output),
    ditheredOutputLevels: uniqueCount(dithered),
  };
}
