function wrapUnit(value: number): number {
  return ((value % 1) + 1) % 1;
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function resultantHue(inputHue: number, hueOffset: number): number {
  return wrapUnit(inputHue + hueOffset);
}

export function relativeSaturation(
  baseSaturation: number,
  saturationOffset: number,
): number {
  return clampUnit(baseSaturation * Math.max(0, 1 + saturationOffset));
}

function createFieldBackground(
  yMin: number,
  yMax: number,
  colorAt: (x: number, offset: number) => string,
): string {
  const rows = 64;
  const stops = 24;
  const definitions: string[] = [];
  const rectangles: string[] = [];
  for (let row = 0; row < rows; row += 1) {
    const normalizedY = (row + 0.5) / rows;
    const offset = yMax - normalizedY * (yMax - yMin);
    const gradientStops = Array.from({ length: stops + 1 }, (_, index) => {
      const x = index / stops;
      return `<stop offset="${x * 100}%" stop-color="${colorAt(x, offset)}"/>`;
    }).join("");
    definitions.push(
      `<linearGradient id="f${row}" x1="0" y1="0" x2="1" y2="0">${gradientStops}</linearGradient>`,
    );
    rectangles.push(
      `<rect x="0" y="${row}" width="100" height="1.05" fill="url(#f${row})"/>`,
    );
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 ${rows}" preserveAspectRatio="none"><defs>${definitions.join("")}</defs>${rectangles.join("")}<rect width="100" height="${rows}" fill="#030712" opacity="0.34"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

export function createHueHueFieldBackground(
  yMin: number,
  yMax: number,
): string {
  return createFieldBackground(yMin, yMax, (inputHue, offset) => {
    const hue = resultantHue(inputHue, offset) * 360;
    return `hsl(${hue},72%,43%)`;
  });
}

export function createHueSaturationFieldBackground(
  yMin: number,
  yMax: number,
): string {
  return createFieldBackground(yMin, yMax, (inputHue, offset) => {
    const saturation = relativeSaturation(0.65, offset) * 100;
    return `hsl(${inputHue * 360},${saturation}%,43%)`;
  });
}

export function createLumaSaturationFieldBackground(
  yMin: number,
  yMax: number,
): string {
  return createFieldBackground(yMin, yMax, (luma, offset) => {
    const saturation = relativeSaturation(0.65, offset) * 100;
    return `hsl(215,${saturation}%,${luma * 100}%)`;
  });
}
