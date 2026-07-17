export const SCOPE_WIDTH = 256;
export const SCOPE_HEIGHT = 128;
export const HISTOGRAM_BINS = 256;

export interface ScopeSnapshot {
  readonly histogram: readonly [Float32Array, Float32Array, Float32Array, Float32Array];
  readonly waveform: Float32Array;
  readonly parade: Float32Array;
  readonly vectorscope: Float32Array;
  readonly sampledAt: number;
}

function normalize(values: Float32Array): Float32Array {
  let maximum = 0;
  for (const value of values) maximum = Math.max(maximum, value);
  if (maximum <= 0) return values;
  for (let index = 0; index < values.length; index += 1) {
    values[index] = Math.sqrt(values[index] / maximum);
  }
  return values;
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value * 255)));
}

export function analyzeScopePixels(
  pixels: ArrayLike<number>,
  width: number,
  _height: number,
  sampledAt = performance.now(),
): ScopeSnapshot {
  const red = new Float32Array(HISTOGRAM_BINS);
  const green = new Float32Array(HISTOGRAM_BINS);
  const blue = new Float32Array(HISTOGRAM_BINS);
  const lumaHistogram = new Float32Array(HISTOGRAM_BINS);
  const waveform = new Float32Array(SCOPE_WIDTH * SCOPE_HEIGHT);
  const parade = new Float32Array(SCOPE_WIDTH * 3 * SCOPE_HEIGHT);
  const vectorscope = new Float32Array(SCOPE_WIDTH * SCOPE_WIDTH);

  for (let offset = 0; offset + 3 < pixels.length; offset += 4) {
    const pixelIndex = offset / 4;
    const alpha = pixels[offset + 3] / 255;
    if (alpha <= 1e-6) continue;
    const r = Math.min(1, pixels[offset] / 255 / alpha);
    const g = Math.min(1, pixels[offset + 1] / 255 / alpha);
    const b = Math.min(1, pixels[offset + 2] / 255 / alpha);
    const luma = Math.max(0, Math.min(1, r * 0.2126 + g * 0.7152 + b * 0.0722));
    red[clampByte(r)] += 1;
    green[clampByte(g)] += 1;
    blue[clampByte(b)] += 1;
    lumaHistogram[clampByte(luma)] += 1;

    const sourceX = pixelIndex % Math.max(1, width);
    const x = Math.min(SCOPE_WIDTH - 1, Math.floor((sourceX / Math.max(1, width)) * SCOPE_WIDTH));
    const y = SCOPE_HEIGHT - 1 - Math.min(SCOPE_HEIGHT - 1, Math.floor(luma * SCOPE_HEIGHT));
    waveform[y * SCOPE_WIDTH + x] += 1;

    const channels = [r, g, b];
    channels.forEach((channel, channelIndex) => {
      const channelX = channelIndex * SCOPE_WIDTH + x;
      const channelY = SCOPE_HEIGHT - 1 - Math.min(SCOPE_HEIGHT - 1, Math.floor(channel * SCOPE_HEIGHT));
      parade[channelY * SCOPE_WIDTH * 3 + channelX] += 1;
    });

    const cb = (b - luma) / 1.8556;
    const cr = (r - luma) / 1.5748;
    const vectorX = Math.max(0, Math.min(SCOPE_WIDTH - 1, Math.round((0.5 + cb) * (SCOPE_WIDTH - 1))));
    const vectorY = Math.max(0, Math.min(SCOPE_WIDTH - 1, Math.round((0.5 - cr) * (SCOPE_WIDTH - 1))));
    vectorscope[vectorY * SCOPE_WIDTH + vectorX] += 1;
  }

  return {
    histogram: [normalize(red), normalize(green), normalize(blue), normalize(lumaHistogram)],
    waveform: normalize(waveform),
    parade: normalize(parade),
    vectorscope: normalize(vectorscope),
    sampledAt,
  };
}
