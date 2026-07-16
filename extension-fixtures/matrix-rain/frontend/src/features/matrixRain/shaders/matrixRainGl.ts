import { GLYPH_STROKE_MASKS } from "../utils/matrixRainMath";

/**
 * WebGL (GLSL ES 3.00) programs for the stateless Phase 2 Matrix appearance.
 *
 * The vertex stage is the standard Pixi v8 filter header. The fragment stage
 * anchors a glyph grid to the input pixel bounds, animates a per-column
 * descending trail and bright head purely from canonical visual time, cycles
 * analytic anti-aliased stroke glyphs deterministically, and maps brightness
 * through a five-colour piecewise palette. No feedback texture is used at this
 * phase.
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

const GLYPH_ARRAY = GLYPH_STROKE_MASKS.map((mask) => `${mask >>> 0}u`).join(", ");

export const MATRIX_RAIN_FRAGMENT = `
#version 300 es

precision highp float;
precision highp int;

in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform sampler2D uState;
uniform vec4 uInputSize;
uniform vec4 uOutputFrame;

uniform float uTimeSeconds;
uniform float uSize;
uniform float uVerticalSpacing;
uniform float uSeed;
uniform float uGlyphCycleRate;
uniform float uFallSpeed;
uniform float uSpeedVariation;
uniform float uTrailShape;
uniform float uPulseDensity;
uniform float uHeadWidth;
uniform float uRainStrength;
uniform float uContrast;
uniform float uHeadIntensity;
uniform float uDirectShapeStrength;
uniform float uDirectMotionStrength;
uniform float uSourceHeadInfluence;
uniform float uMotionHeadInfluence;
uniform float uBaseInjection;
uniform float uAmbientSpawn;
uniform float uSourceInfluence;
uniform float uMotionInfluence;
uniform float uMotionImmediateAmount;
uniform float uInjectionStrength;
uniform float uInjectionGate;
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
// Normalized analytic stroke vocabulary: five horizontals, two outer
// verticals, one full centre vertical, two full diagonals, four diamond
// diagonals, and two half-height centre verticals.
const vec2 SEGMENT_A[16] = vec2[16](
  vec2(0.22, 0.14), vec2(0.30, 0.34), vec2(0.18, 0.50), vec2(0.30, 0.66),
  vec2(0.22, 0.86), vec2(0.20, 0.15), vec2(0.80, 0.15), vec2(0.50, 0.12),
  vec2(0.22, 0.15), vec2(0.78, 0.15), vec2(0.50, 0.15), vec2(0.50, 0.15),
  vec2(0.20, 0.50), vec2(0.80, 0.50), vec2(0.50, 0.15), vec2(0.50, 0.50)
);
const vec2 SEGMENT_B[16] = vec2[16](
  vec2(0.78, 0.14), vec2(0.70, 0.34), vec2(0.82, 0.50), vec2(0.70, 0.66),
  vec2(0.78, 0.86), vec2(0.20, 0.85), vec2(0.80, 0.85), vec2(0.50, 0.88),
  vec2(0.78, 0.85), vec2(0.22, 0.85), vec2(0.20, 0.50), vec2(0.80, 0.50),
  vec2(0.50, 0.85), vec2(0.50, 0.85), vec2(0.50, 0.50), vec2(0.50, 0.85)
);

uint pcgHash(uint v) {
  uint state = v * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
uint hash2(uint a, uint b) { return pcgHash(a ^ pcgHash(b)); }
uint hash3(uint a, uint b, uint c) { return pcgHash(a ^ hash2(b, c)); }
float unitFloat(uint h) { return float(h & 0x00ffffffu) / 16777216.0; }

float segmentDistance(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

float glyphCoverage(uint glyphIndex, vec2 uv) {
  uint strokeMask = GLYPHS[int(glyphIndex)];
  float distanceToStroke = 10.0;
  for (int segment = 0; segment < 16; segment++) {
    uint segmentBit = 1u << uint(segment);
    if ((strokeMask & segmentBit) != 0u) {
      distanceToStroke = min(
        distanceToStroke,
        segmentDistance(uv, SEGMENT_A[segment], SEGMENT_B[segment])
      );
    }
  }
  float antialias = max(fwidth(distanceToStroke), 0.0015);
  return 1.0 - smoothstep(
    0.055 - antialias,
    0.055 + antialias,
    distanceToStroke
  );
}

vec3 paletteGrade(float b) {
  b = clamp(b, 0.0, 1.0);
  if (b <= 0.5) {
    return mix(uShadow, uBody, b / 0.5);
  }
  return mix(uBody, uBright, (b - 0.5) / 0.5);
}

float contrastCurve(float value) {
  float x = clamp(value, 0.0, 1.0);
  float exponent = exp2((uContrast - 1.0) * 2.0);
  if (x < 0.5) {
    return 0.5 * pow(2.0 * x, exponent);
  }
  return 1.0 - 0.5 * pow(2.0 * (1.0 - x), exponent);
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
  float rowPitch = size + max(uVerticalSpacing, 0.0);
  vec2 cellIndex = vec2(floor(pixel.x / size), floor(pixel.y / rowPitch));
  vec2 sub = vec2(
    fract(pixel.x / size),
    mod(pixel.y, rowPitch) / size
  );
  float glyphRegion = sub.y < 1.0 ? 1.0 : 0.0;
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
  float proceduralTrail = pow(fade, max(uTrailShape, 1e-3));
  float trail = proceduralTrail * uRainStrength;
  float headEdge = max(uHeadWidth, 1e-4);
  float head = 1.0 - smoothstep(0.0, headEdge, d / spacing);

  uint bucket = uint(floor(max(uTimeSeconds, 0.0) * uGlyphCycleRate));
  uint gi = hash3(col, row, bucket ^ seed) % 16u;
  float lit = glyphCoverage(gi, sub) * glyphRegion;

  // Read the one-texel-per-cell state explicitly at its texel centre. This
  // prevents adjacent cells bleeding together in the full-resolution pass.
  vec2 stateSize = max(vec2(textureSize(uState, 0)), vec2(1.0));
  vec2 stateCell = clamp(cellIndex, vec2(0.0), stateSize - vec2(1.0));
  vec2 stateUv = (stateCell + vec2(0.5)) / stateSize;
  vec4 state = texture(uState, stateUv);
  float rainR = state.r;   // accumulated / advected rain
  float headG = state.g;   // advected source-seeded head vitality
  float signalB = state.b; // current source signal (luma)
  float motionA = state.a; // current motion / change signal

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
  if (dbgMode == 4) {
    // rainState: R=rain, G=head, B=source signal.
    finalColor = vec4(clamp(vec3(rainR, headG, signalB), 0.0, 1.0), 1.0);
    return;
  }
  if (dbgMode == 5) {
    // advectedPrevious: the accumulated rain channel isolated.
    finalColor = vec4(0.0, clamp(rainR, 0.0, 1.0), 0.0, 1.0);
    return;
  }
  if (dbgMode == 6) {
    // currentSignal: the shaped source signal (B).
    finalColor = vec4(0.0, clamp(signalB, 0.0, 1.0), 0.0, 1.0);
    return;
  }
  if (dbgMode == 7) {
    // motion: the change signal (A).
    finalColor = vec4(clamp(motionA, 0.0, 1.0) * vec3(1.0, 0.4, 0.2), 1.0);
    return;
  }
  if (dbgMode == 8) {
    float pulseIndex = floor((headLine - float(row)) / spacing);
    uint pulseKey = uint(int(pulseIndex));
    float spawnNoise = unitFloat(hash2(hash2(col, pulseKey), seed));
    float spawnDrive = clamp(
      uSourceInfluence * signalB + uMotionInfluence * motionA,
      0.0,
      1.0
    );
    float baseSpawnProbability = 1.0
      - (1.0 - clamp(uAmbientSpawn, 0.0, 1.0)) * (1.0 - spawnDrive);
    float spawnRateScale = max(uPulseDensity / 0.7, 1e-4);
    float spawnProbability = 1.0 - pow(
      1.0 - baseSpawnProbability,
      spawnRateScale
    );
    float streamGate = spawnNoise < spawnProbability ? 1.0 : 0.0;
    float trailGate = proceduralTrail * streamGate;
    float motionGate = streamGate
      * (proceduralTrail + (1.0 - proceduralTrail) * uMotionImmediateAmount);
    float injection = clamp(
      (uBaseInjection * trailGate
        + uSourceInfluence * signalB * trailGate
        + uMotionInfluence * motionA * motionGate)
        * uInjectionStrength * uInjectionGate,
      0.0,
      1.0
    );
    finalColor = vec4(vec3(injection), 1.0);
    return;
  }

  // Final body brightness combines accumulated rain with the direct
  // current-shape and motion terms, so a newly visible or moving source is
  // recognizable immediately, before rain history develops.
  float rawBodyState = rainR * uRainStrength
    + signalB * uDirectShapeStrength
    + motionA * uDirectMotionStrength;
  float bodyState = contrastCurve(rawBodyState);
  float bodyB = clamp(bodyState, 0.0, 1.0) * lit;
  // Source and motion boost the isolated pale head where they are strong.
  float headScalar = headG
    * (1.0 + uSourceHeadInfluence * signalB + uMotionHeadInfluence * motionA);
  float headB = headScalar * uHeadIntensity * lit;
  float coverage = clamp(bodyB + headB, 0.0, 1.0);
  vec3 grade = paletteGrade(bodyState);

  // Static per-pixel dither (no time bucket, so the background never shimmers)
  // scaled by glyph coverage, so the flat background stays exactly uBackground
  // and transparent output stays fully transparent.
  float dither = (unitFloat(hash2(uint(pixel.x), uint(pixel.y))) - 0.5)
    * uDitherMagnitude * coverage;

  if (outMode == 1) {
    // matrixOnly: dither the straight colour, then premultiply by coverage so no
    // channel can exceed alpha (no bright compositing fringe).
    vec3 straight = clamp(
      grade + uHead * headScalar * uHeadIntensity + vec3(dither),
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
