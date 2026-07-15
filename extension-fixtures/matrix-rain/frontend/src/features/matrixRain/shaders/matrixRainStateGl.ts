/**
 * WebGL (GLSL ES 3.00) state-update program for Phase 3 temporal feedback.
 *
 * It reads the current filter input and the previous state texture and writes
 * the next state with one output texel per glyph cell:
 *   R = accumulated / advected rain brightness
 *   G = current procedural head brightness
 *   B = current source signal (luma) for the next sample
 *   A = motion / change signal (0 in Phase 3; Phase 4 fills it)
 *
 * The hash, cell mapping, and procedural trail/head here are copied verbatim
 * from `matrixRainGl.ts`, and the decay/advection/soft-add mirror
 * `matrixRainMath.ts`, so the CPU reference and both shader passes stay aligned.
 */

export const MATRIX_RAIN_STATE_VERTEX = `
#version 300 es

in vec2 aPosition;
out vec2 vTextureCoord;
out vec2 vStateCoord;
uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

void main(void) {
  // The input is full-resolution while the output is the cell-grid texture.
  // Cover the output target explicitly instead of using the input frame size.
  vec2 position = aPosition * uOutputTexture.xy;
  position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
  position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
  gl_Position = vec4(position, 0.0, 1.0);
  vTextureCoord = aPosition * (uOutputFrame.zw * uInputSize.zw);
  vStateCoord = aPosition;
}
`;

export const MATRIX_RAIN_STATE_FRAGMENT = `
#version 300 es

precision highp float;
precision highp int;

in vec2 vTextureCoord;
in vec2 vStateCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform sampler2D uPrevState;
uniform vec4 uInputSize;
uniform vec4 uInputClamp;
uniform vec4 uOutputFrame;

uniform float uTimeSeconds;
uniform float uDeltaSeconds;
uniform float uSize;
uniform float uVerticalSpacing;
uniform float uSeed;
uniform float uFallSpeed;
uniform float uSpeedVariation;
uniform float uTrailShape;
uniform float uPulseDensity;
uniform float uHeadWidth;
uniform float uTrailHalfLife;
uniform float uBaseInjection;
uniform float uSourceInfluence;
uniform float uReset;
uniform vec2 uContentSize;
uniform vec2 uStateSize;

uint pcgHash(uint v) {
  uint state = v * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
uint hash2(uint a, uint b) { return pcgHash(a ^ pcgHash(b)); }
float unitFloat(uint h) { return float(h & 0x00ffffffu) / 16777216.0; }

void main(void) {
  vec2 frameSize = max(uOutputFrame.zw, vec2(1.0));
  vec2 contentSize = uContentSize;
  if (contentSize.x <= 0.0 || contentSize.y <= 0.0) {
    contentSize = frameSize;
  }
  float size = max(uSize, 1.0);
  float rowPitch = size + max(uVerticalSpacing, 0.0);
  vec2 stateSize = max(uStateSize, vec2(1.0));
  vec2 cellIndex = clamp(
    floor(vStateCoord * stateSize),
    vec2(0.0),
    stateSize - vec2(1.0)
  );
  uint col = uint(max(cellIndex.x, 0.0));
  uint row = uint(max(cellIndex.y, 0.0));
  uint seed = uint(max(uSeed, 0.0));

  // Procedural trail + head (identical to the glyph program).
  float spacing = clamp(22.0 / max(uPulseDensity, 1e-4), 4.0, 512.0);
  float speedRandom = unitFloat(hash2(col * 2u + 1u, seed));
  float phase = unitFloat(hash2(col * 2u, seed));
  float speed = uFallSpeed * (1.0 - uSpeedVariation * speedRandom);
  float headLine = phase * spacing + uTimeSeconds * speed;
  float d = mod(headLine - float(row), spacing);
  float fade = max(0.0, 1.0 - d / spacing);
  float proceduralTrail = pow(fade, max(uTrailShape, 1e-3));
  float headEdge = max(uHeadWidth, 1e-4);
  float proceduralHead = 1.0 - smoothstep(0.0, headEdge, d / spacing);

  // Current source signal (Rec.709 luma on unpremultiplied RGB).
  vec2 sourcePixel = vec2(
    (cellIndex.x + 0.5) * size,
    (cellIndex.y + 0.5) * rowPitch
  );
  vec2 sourceUv = sourcePixel * (frameSize / contentSize) * uInputSize.zw;
  vec4 src = texture(uTexture, clamp(sourceUv, uInputClamp.xy, uInputClamp.zw));
  vec3 rgb = src.a > 0.0 ? src.rgb / src.a : src.rgb;
  float currentSignal = clamp(dot(rgb, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);

  // Advect the previous rain down the column by fallSpeed*dt cells, sampling
  // with linear interpolation for fractional-cell motion.
  float fallCells = uFallSpeed * max(uDeltaSeconds, 0.0);
  float previousRow = cellIndex.y - fallCells;
  vec2 previousUv = vec2(
    (cellIndex.x + 0.5) / stateSize.x,
    (previousRow + 0.5) / stateSize.y
  );
  // Fade against a zero-valued top border for the fractional cell immediately
  // above row zero; clamp-to-edge alone would smear the first row indefinitely.
  float previousRowWeight = clamp(previousRow + 1.0, 0.0, 1.0);
  // On a reset frame the previous state is stale/garbage (fresh allocation or
  // a discontinuity), so ignore it and start the trail cold.
  float advectedRain =
    texture(uPrevState, clamp(previousUv, vec2(0.0), vec2(1.0))).r
      * previousRowWeight * (1.0 - uReset);

  float retention = exp2(-max(uDeltaSeconds, 0.0) / max(uTrailHalfLife, 1e-4));
  float decayed = advectedRain * retention;
  // Static injection is gated by the procedural trail (so a still silhouette
  // never saturates) and by delta (so a zero-delta/paused sample adds nothing).
  float injectionGate = uDeltaSeconds > 0.0 ? 1.0 : 0.0;
  float injection = clamp(
    (uBaseInjection + uSourceInfluence * currentSignal * proceduralTrail)
      * injectionGate,
    0.0,
    1.0
  );
  float nextRain = 1.0 - (1.0 - clamp(decayed, 0.0, 1.0)) * (1.0 - injection);

  finalColor = vec4(
    nextRain,
    clamp(proceduralHead, 0.0, 1.0),
    currentSignal,
    0.0
  );
}
`;
