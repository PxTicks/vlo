/**
 * WebGL (GLSL ES 3.00) state-update program for Phase 3 temporal feedback.
 *
 * It reads the current filter input and the previous state texture and writes
 * the next state with one output texel per glyph cell:
 *   R = accumulated / advected rain brightness
 *   G = advected source-seeded head vitality
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
uniform float uSignalMode;
uniform float uLumaWeight;
uniform float uEdgeWeight;
uniform float uEdgeGain;
uniform float uAlphaEdgeWeight;
uniform float uSignalThreshold;
uniform float uSignalGain;
uniform float uSignalGamma;
uniform float uTrailHalfLife;
uniform float uBaseInjection;
uniform float uAmbientSpawn;
uniform float uSourceInfluence;
uniform float uMotionInfluence;
uniform float uMotionMode;
uniform float uMotionThreshold;
uniform float uMotionGain;
uniform float uMotionImmediateAmount;
uniform float uInjectionStrength;
uniform float uDarkDamping;
uniform float uAccumulationMode;
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

float lumaOf(vec3 rgb) { return dot(rgb, vec3(0.2126, 0.7152, 0.0722)); }
vec4 sampleSource(vec2 uv) {
  return texture(uTexture, clamp(uv, uInputClamp.xy, uInputClamp.zw));
}
float unlum(vec4 s) {
  vec3 rgb = s.a > 0.0 ? s.rgb / s.a : s.rgb;
  return lumaOf(rgb);
}

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
  // One stable random decision per column/pulse. The same pulse key follows
  // the analytic head down the column, so accepted streams never flicker.
  float pulseIndex = floor((headLine - float(row)) / spacing);
  uint pulseKey = uint(int(pulseIndex));
  float spawnNoise = unitFloat(hash2(hash2(col, pulseKey), seed));
  float previousPulseIndex = floor(
    (headLine - speed * max(uDeltaSeconds, 0.0) - float(row)) / spacing
  );
  float headCrossed = previousPulseIndex < pulseIndex ? 1.0 : 0.0;

  // Current source signal: sample the cell centre plus four cell-scale
  // neighbours and assemble per the selected signal mode.
  vec2 texelStep = (frameSize / contentSize) * uInputSize.zw;
  vec2 sourcePixel = vec2(
    (cellIndex.x + 0.5) * size,
    (cellIndex.y + 0.5) * rowPitch
  );
  vec2 sourceUv = sourcePixel * texelStep;
  vec2 offX = vec2(size, 0.0) * texelStep;
  vec2 offY = vec2(0.0, rowPitch) * texelStep;
  vec4 sc = sampleSource(sourceUv);
  vec4 sL = sampleSource(sourceUv - offX);
  vec4 sR = sampleSource(sourceUv + offX);
  vec4 sU = sampleSource(sourceUv - offY);
  vec4 sD = sampleSource(sourceUv + offY);
  float lumaC = unlum(sc);
  float colorEdge =
    (abs(unlum(sL) - lumaC) + abs(unlum(sR) - lumaC)
      + abs(unlum(sU) - lumaC) + abs(unlum(sD) - lumaC)) * uEdgeGain;
  float alphaEdge =
    (abs(sL.a - sc.a) + abs(sR.a - sc.a)
      + abs(sU.a - sc.a) + abs(sD.a - sc.a)) * uEdgeGain;

  int signalMode = int(uSignalMode + 0.5);
  float rawSignal;
  if (signalMode == 1) {
    // Empty transparent pixels must not become a full-strength dark signal.
    rawSignal = sc.a * (1.0 - lumaC);
  } else if (signalMode == 2) {
    rawSignal = colorEdge;
  } else if (signalMode == 3) {
    rawSignal = uLumaWeight * lumaC + uEdgeWeight * colorEdge;
  } else if (signalMode == 4) {
    rawSignal = sc.a;
  } else if (signalMode == 5) {
    rawSignal = uAlphaEdgeWeight * alphaEdge + uEdgeWeight * colorEdge;
  } else {
    rawSignal = lumaC;
  }
  float aboveThreshold =
    max(0.0, rawSignal - uSignalThreshold) / max(1.0 - uSignalThreshold, 1e-4);
  float currentSignal = clamp(
    pow(clamp(aboveThreshold, 0.0, 1.0), max(uSignalGamma, 1e-3)) * uSignalGain,
    0.0,
    1.0
  );

  // Motion: compare with the previous signal at the SAME cell (prev state B).
  vec2 sameCellUv = vec2(
    (cellIndex.x + 0.5) / stateSize.x,
    (cellIndex.y + 0.5) / stateSize.y
  );
  float previousSignal = mix(
    texture(uPrevState, clamp(sameCellUv, vec2(0.0), vec2(1.0))).b,
    currentSignal,
    uReset
  );
  int motionMode = int(uMotionMode + 0.5);
  float deltaSignal = currentSignal - previousSignal;
  float rawMotion = motionMode == 1 ? max(deltaSignal, 0.0) : abs(deltaSignal);
  float motion =
    clamp(max(0.0, rawMotion - uMotionThreshold) * uMotionGain, 0.0, 1.0);

  // Source drive controls stream frequency separately from brightness.
  float spawnDrive = clamp(
    uSourceInfluence * currentSignal + uMotionInfluence * motion,
    0.0,
    1.0
  );
  float spawnProbability = 1.0
    - (1.0 - clamp(uAmbientSpawn, 0.0, 1.0)) * (1.0 - spawnDrive);
  float streamGate = spawnNoise < spawnProbability ? 1.0 : 0.0;

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
  vec4 advectedState = texture(
    uPrevState,
    clamp(previousUv, vec2(0.0), vec2(1.0))
  );
  float historyGate = previousRowWeight * (1.0 - uReset);
  float advectedRain = advectedState.r * historyGate;
  float advectedHead = advectedState.g * historyGate;

  float retention = exp2(-max(uDeltaSeconds, 0.0) / max(uTrailHalfLife, 1e-4));
  // Continuous source-conditioned damping remains frame-rate independent.
  float sourceSurvival = exp2(
    -max(uDeltaSeconds, 0.0)
      * max(uDarkDamping, 0.0)
      * (1.0 - currentSignal)
  );
  float decayed = advectedRain * retention * sourceSurvival;
  float carriedHead = advectedHead * sourceSurvival;
  // Static injection is gated by the procedural trail (so a still silhouette
  // never saturates) and by delta (so a zero-delta/paused sample adds nothing).
  // Motion injection can bypass the procedural gate by motionImmediateAmount.
  float injectionGate = uDeltaSeconds > 0.0 ? 1.0 : 0.0;
  float trailGate = proceduralTrail * streamGate;
  float motionGate = streamGate
    * (proceduralTrail + (1.0 - proceduralTrail) * uMotionImmediateAmount);
  float baseInject = uBaseInjection * trailGate;
  float sourceInject = uSourceInfluence * currentSignal * trailGate;
  float motionInject = uMotionInfluence * motion * motionGate;
  float injection = clamp(
    (baseInject + sourceInject + motionInject)
      * uInjectionStrength * injectionGate,
    0.0,
    1.0
  );

  float dc = clamp(decayed, 0.0, 1.0);
  float ic = clamp(injection, 0.0, 1.0);
  int accumMode = int(uAccumulationMode + 0.5);
  float nextRain;
  if (accumMode == 1) {
    nextRain = max(dc, ic);
  } else if (accumMode == 2) {
    nextRain = clamp(dc + ic, 0.0, 1.0);
  } else {
    nextRain = 1.0 - (1.0 - dc) * (1.0 - ic);
  }
  // Crossing detection prevents a narrow head from being skipped when it
  // passes a cell between two bounded history samples.
  float headSeed = max(proceduralHead, headCrossed) * streamGate;
  float nextHead = max(carriedHead, headSeed);

  finalColor = vec4(
    nextRain,
    clamp(nextHead, 0.0, 1.0),
    currentSignal,
    clamp(motion, 0.0, 1.0)
  );
}
`;
