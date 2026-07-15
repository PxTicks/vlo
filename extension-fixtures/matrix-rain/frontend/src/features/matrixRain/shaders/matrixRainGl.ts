import { GLYPH_BITMASKS } from "../utils/matrixRainMath";

/**
 * WebGL (GLSL ES 3.00) programs for the stateless Phase 2 Matrix appearance.
 *
 * The vertex stage is the standard Pixi v8 filter header. The fragment stage
 * anchors a glyph grid to the input pixel bounds, animates a per-column
 * descending trail and bright head purely from canonical visual time, cycles
 * fixed 5×5 bitmask glyphs deterministically, and maps brightness through a
 * five-colour piecewise palette. No feedback texture is used at this phase.
 *
 * Every hash, glyph, and profile here mirrors `matrixRainMath.ts` (the CPU
 * reference) and `matrixRainWgsl.ts`, so the three can never drift.
 */

export const MATRIX_RAIN_VERTEX = `
#version 300 es

in vec2 aPosition;
out vec2 vTextureCoord;
uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

void main(void) {
  vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
  position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
  position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
  gl_Position = vec4(position, 0.0, 1.0);
  vTextureCoord = aPosition * (uOutputFrame.zw * uInputSize.zw);
}
`;

const GLYPH_ARRAY = GLYPH_BITMASKS.map((mask) => `${mask >>> 0}u`).join(", ");

export const MATRIX_RAIN_FRAGMENT = `
#version 300 es

precision highp float;
precision highp int;

in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform vec4 uInputSize;
uniform vec4 uOutputFrame;

uniform float uTimeSeconds;
uniform float uSize;
uniform float uSeed;
uniform float uGlyphCycleRate;
uniform float uFallSpeed;
uniform float uSpeedVariation;
uniform float uTrailShape;
uniform float uPulseDensity;
uniform float uHeadWidth;
uniform float uRainStrength;
uniform float uHeadIntensity;
uniform float uDitherMagnitude;
uniform float uOutputMode;
uniform float uDebugMode;
uniform vec2 uContentSize;
uniform vec3 uBackground;
uniform vec3 uShadow;
uniform vec3 uBody;
uniform vec3 uBright;
uniform vec3 uHead;

const uint GLYPHS[16] = uint[16](${GLYPH_ARRAY});

uint pcgHash(uint v) {
  uint state = v * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
uint hash2(uint a, uint b) { return pcgHash(a ^ pcgHash(b)); }
uint hash3(uint a, uint b, uint c) { return pcgHash(a ^ hash2(b, c)); }
float unitFloat(uint h) { return float(h & 0x00ffffffu) / 16777216.0; }

vec3 paletteGrade(float b) {
  b = clamp(b, 0.0, 1.0);
  if (b <= 0.5) {
    return mix(uShadow, uBody, b / 0.5);
  }
  return mix(uBody, uBright, (b - 0.5) / 0.5);
}

void main(void) {
  int outMode = int(uOutputMode + 0.5);
  int dbgMode = int(uDebugMode + 0.5);

  vec2 frameSize = max(uOutputFrame.zw, vec2(1.0));
  vec2 contentSize = uContentSize;
  if (contentSize.x <= 0.0 || contentSize.y <= 0.0) {
    contentSize = frameSize;
  }
  // Convert filter-frame pixels back into source-local pixels. Spatial
  // transforms then scale the completed glyph grid naturally instead of the
  // grid remaining screen-sized and sliding as the clip is zoomed.
  vec2 pixel = vTextureCoord * uInputSize.xy * (contentSize / frameSize);
  float size = max(uSize, 1.0);
  vec2 cellf = pixel / size;
  vec2 cellIndex = floor(cellf);
  vec2 sub = cellf - cellIndex;
  uint col = uint(max(cellIndex.x, 0.0));
  uint row = uint(max(cellIndex.y, 0.0));
  uint seed = uint(max(uSeed, 0.0));

  float spacing = clamp(22.0 / max(uPulseDensity, 1e-4), 4.0, 512.0);
  float speedRandom = unitFloat(hash2(col * 2u + 1u, seed));
  float phase = unitFloat(hash2(col * 2u, seed));
  float speed = uFallSpeed * (1.0 - uSpeedVariation * speedRandom);
  float headLine = phase * spacing + uTimeSeconds * speed;
  float d = mod(headLine - float(row), spacing);
  float fade = max(0.0, 1.0 - d / spacing);
  float trail = pow(fade, max(uTrailShape, 1e-3)) * uRainStrength;
  float headEdge = max(uHeadWidth, 1e-4);
  float head = 1.0 - smoothstep(0.0, headEdge, d / spacing);

  uint bucket = uint(floor(max(uTimeSeconds, 0.0) * uGlyphCycleRate));
  uint gi = hash3(col, row, bucket ^ seed) % 16u;
  int bx = int(clamp(sub.x * 5.0, 0.0, 4.0));
  int by = int(clamp(sub.y * 5.0, 0.0, 4.0));
  uint bit = uint(by * 5 + bx);
  float lit = float((GLYPHS[int(gi)] >> bit) & 1u);

  // Debug views short-circuit the palette compositing.
  if (dbgMode == 1) {
    float border = (sub.x < 0.06 || sub.y < 0.06) ? 1.0 : 0.0;
    vec3 grid = mix(vec3(0.0, 0.15, 0.0), vec3(0.0, 0.6, 0.0), border);
    finalColor = vec4(grid + vec3(0.0, lit * 0.5, 0.0), 1.0);
    return;
  }
  if (dbgMode == 2) {
    finalColor = vec4(0.0, clamp(trail, 0.0, 1.0), 0.0, 1.0);
    return;
  }
  if (dbgMode == 3) {
    finalColor = vec4(clamp(head, 0.0, 1.0) * vec3(0.6, 1.0, 0.75), 1.0);
    return;
  }

  float bodyB = clamp(trail, 0.0, 1.0) * lit;
  float headB = head * uHeadIntensity * lit;
  float coverage = clamp(bodyB + headB, 0.0, 1.0);
  vec3 grade = paletteGrade(trail);

  // Static per-pixel dither (no time bucket, so the background never shimmers)
  // scaled by glyph coverage, so the flat background stays exactly uBackground
  // and transparent output stays fully transparent.
  float dither = (unitFloat(hash2(uint(pixel.x), uint(pixel.y))) - 0.5)
    * uDitherMagnitude * coverage;

  if (outMode == 1) {
    // matrixOnly: dither the straight colour, then premultiply by coverage so no
    // channel can exceed alpha (no bright compositing fringe).
    vec3 straight = clamp(
      grade + uHead * head * uHeadIntensity + vec3(dither),
      0.0,
      1.0
    );
    finalColor = vec4(straight * coverage, coverage);
  } else {
    // replaceBlack: opaque background with Matrix glyphs.
    vec3 rgb = mix(uBackground, grade, bodyB) + uHead * headB + vec3(dither);
    finalColor = vec4(rgb, 1.0);
  }
}
`;
