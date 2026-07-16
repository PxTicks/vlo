/**
 * WebGPU (WGSL) state-update program for source-conditioned temporal feedback. A
 * line-for-line mirror of `matrixRainStateGl.ts`.
 *
 * `@group(0)` holds the global filter uniforms plus the input texture/sampler.
 * `@group(1)` holds this pass's uniform struct (binding 0) and the previous
 * state texture/sampler (bindings 1 and 2). The `StateUniforms` field order MUST
 * match the JS uniform insertion order in `MatrixRainStateFilter.ts`.
 */

export const MATRIX_RAIN_STATE_WGSL_VERTEX_ENTRY = "mainVertex";
export const MATRIX_RAIN_STATE_WGSL_FRAGMENT_ENTRY = "mainFragment";

export const MATRIX_RAIN_STATE_WGSL = `
struct GlobalFilterUniforms {
  uInputSize: vec4<f32>,
  uInputPixel: vec4<f32>,
  uInputClamp: vec4<f32>,
  uOutputFrame: vec4<f32>,
  uGlobalFrame: vec4<f32>,
  uOutputTexture: vec4<f32>,
};

struct StateUniforms {
  uTimeSeconds: f32,
  uDeltaSeconds: f32,
  uSize: f32,
  uVerticalSpacing: f32,
  uSeed: f32,
  uFallSpeed: f32,
  uSpeedVariation: f32,
  uTrailShape: f32,
  uPulseDensity: f32,
  uHeadWidth: f32,
  uSignalMode: f32,
  uLumaWeight: f32,
  uEdgeWeight: f32,
  uEdgeGain: f32,
  uAlphaEdgeWeight: f32,
  uSignalThreshold: f32,
  uSignalGain: f32,
  uSignalGamma: f32,
  uTrailHalfLife: f32,
  uBaseInjection: f32,
  uAmbientSpawn: f32,
  uSourceInfluence: f32,
  uMotionInfluence: f32,
  uMotionMode: f32,
  uMotionThreshold: f32,
  uMotionGain: f32,
  uMotionImmediateAmount: f32,
  uInjectionStrength: f32,
  uDarkDamping: f32,
  uAccumulationMode: f32,
  uReset: f32,
  uContentSize: vec2<f32>,
  uStateSize: vec2<f32>,
};

@group(0) @binding(0) var<uniform> gfu: GlobalFilterUniforms;
@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var uSampler: sampler;
@group(1) @binding(0) var<uniform> su: StateUniforms;
@group(1) @binding(1) var uPrevState: texture_2d<f32>;
@group(1) @binding(2) var uPrevStateSampler: sampler;

fn pcgHash(v: u32) -> u32 {
  let state = v * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
fn hash2(a: u32, b: u32) -> u32 { return pcgHash(a ^ pcgHash(b)); }
fn unitFloat(h: u32) -> f32 { return f32(h & 0x00ffffffu) / 16777216.0; }

fn lumaOf(rgb: vec3<f32>) -> f32 { return dot(rgb, vec3<f32>(0.2126, 0.7152, 0.0722)); }
fn sampleSource(uv: vec2<f32>) -> vec4<f32> {
  return textureSample(uTexture, uSampler, clamp(uv, gfu.uInputClamp.xy, gfu.uInputClamp.zw));
}
fn unlum(s: vec4<f32>) -> f32 {
  var rgb = s.rgb;
  if (s.a > 0.0) { rgb = s.rgb / s.a; }
  return lumaOf(rgb);
}

fn filterVertexPosition(aPosition: vec2<f32>) -> vec4<f32> {
  var position = aPosition * gfu.uOutputTexture.xy;
  position.x = position.x * (2.0 / gfu.uOutputTexture.x) - 1.0;
  position.y = position.y * (2.0 * gfu.uOutputTexture.z / gfu.uOutputTexture.y) - gfu.uOutputTexture.z;
  return vec4<f32>(position, 0.0, 1.0);
}
fn filterTextureCoord(aPosition: vec2<f32>) -> vec2<f32> {
  return aPosition * (gfu.uOutputFrame.zw * gfu.uInputSize.zw);
}

struct VSOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) stateCoord: vec2<f32>,
};

@vertex
fn mainVertex(@location(0) aPosition: vec2<f32>) -> VSOutput {
  return VSOutput(
    filterVertexPosition(aPosition),
    filterTextureCoord(aPosition),
    aPosition,
  );
}

@fragment
fn mainFragment(
  @location(0) uv: vec2<f32>,
  @location(1) stateCoord: vec2<f32>,
) -> @location(0) vec4<f32> {
  let frameSize = max(gfu.uOutputFrame.zw, vec2<f32>(1.0));
  var contentSize = su.uContentSize;
  if (contentSize.x <= 0.0 || contentSize.y <= 0.0) {
    contentSize = frameSize;
  }
  let size = max(su.uSize, 1.0);
  let rowPitch = size + max(su.uVerticalSpacing, 0.0);
  let stateSize = max(su.uStateSize, vec2<f32>(1.0));
  let cellIndex = clamp(
    floor(stateCoord * stateSize),
    vec2<f32>(0.0),
    stateSize - vec2<f32>(1.0),
  );
  let col = u32(max(cellIndex.x, 0.0));
  let row = u32(max(cellIndex.y, 0.0));
  let seed = u32(max(su.uSeed, 0.0));

  let spacing = clamp(22.0 / max(su.uPulseDensity, 1e-4), 4.0, 512.0);
  let speedRandom = unitFloat(hash2(col * 2u + 1u, seed));
  let phase = unitFloat(hash2(col * 2u, seed));
  let speed = su.uFallSpeed * (1.0 - su.uSpeedVariation * speedRandom);
  let headLine = phase * spacing + su.uTimeSeconds * speed;
  var d = headLine - f32(row);
  d = d - spacing * floor(d / spacing);
  let fade = max(0.0, 1.0 - d / spacing);
  let proceduralTrail = pow(fade, max(su.uTrailShape, 1e-3));
  let headEdge = max(su.uHeadWidth, 1e-4);
  let proceduralHead = 1.0 - smoothstep(0.0, headEdge, d / spacing);
  // One stable random decision per column/pulse. Bitcasting the signed pulse
  // index keeps pre-roll pulses aligned with GLSL and the CPU reference.
  let pulseIndex = floor((headLine - f32(row)) / spacing);
  let pulseKey = bitcast<u32>(i32(pulseIndex));
  let spawnNoise = unitFloat(hash2(hash2(col, pulseKey), seed));
  let previousPulseIndex = floor(
    (headLine - speed * max(su.uDeltaSeconds, 0.0) - f32(row)) / spacing,
  );
  let headCrossed = select(0.0, 1.0, previousPulseIndex < pulseIndex);

  // Current source signal: sample the cell centre plus four cell-scale
  // neighbours and assemble per the selected signal mode.
  let texelStep = (frameSize / contentSize) * gfu.uInputSize.zw;
  let sourcePixel = vec2<f32>(
    (cellIndex.x + 0.5) * size,
    (cellIndex.y + 0.5) * rowPitch,
  );
  let sourceUv = sourcePixel * texelStep;
  let offX = vec2<f32>(size, 0.0) * texelStep;
  let offY = vec2<f32>(0.0, rowPitch) * texelStep;
  let sc = sampleSource(sourceUv);
  let sL = sampleSource(sourceUv - offX);
  let sR = sampleSource(sourceUv + offX);
  let sU = sampleSource(sourceUv - offY);
  let sD = sampleSource(sourceUv + offY);
  let lumaC = unlum(sc);
  let colorEdge =
    (abs(unlum(sL) - lumaC) + abs(unlum(sR) - lumaC)
      + abs(unlum(sU) - lumaC) + abs(unlum(sD) - lumaC)) * su.uEdgeGain;
  let alphaEdge =
    (abs(sL.a - sc.a) + abs(sR.a - sc.a)
      + abs(sU.a - sc.a) + abs(sD.a - sc.a)) * su.uEdgeGain;

  let signalMode = i32(su.uSignalMode + 0.5);
  var rawSignal = lumaC;
  if (signalMode == 1) {
    rawSignal = sc.a * (1.0 - lumaC);
  } else if (signalMode == 2) {
    rawSignal = colorEdge;
  } else if (signalMode == 3) {
    rawSignal = su.uLumaWeight * lumaC + su.uEdgeWeight * colorEdge;
  } else if (signalMode == 4) {
    rawSignal = sc.a;
  } else if (signalMode == 5) {
    rawSignal = su.uAlphaEdgeWeight * alphaEdge + su.uEdgeWeight * colorEdge;
  }
  let aboveThreshold =
    max(0.0, rawSignal - su.uSignalThreshold) / max(1.0 - su.uSignalThreshold, 1e-4);
  let currentSignal = clamp(
    pow(clamp(aboveThreshold, 0.0, 1.0), max(su.uSignalGamma, 1e-3)) * su.uSignalGain,
    0.0,
    1.0
  );

  // Motion: compare with the previous signal at the SAME cell (prev state B).
  let sameCellUv = vec2<f32>(
    (cellIndex.x + 0.5) / stateSize.x,
    (cellIndex.y + 0.5) / stateSize.y,
  );
  let previousSignal = mix(
    textureSample(uPrevState, uPrevStateSampler, clamp(sameCellUv, vec2<f32>(0.0), vec2<f32>(1.0))).b,
    currentSignal,
    su.uReset
  );
  let motionMode = i32(su.uMotionMode + 0.5);
  let deltaSignal = currentSignal - previousSignal;
  var rawMotion = abs(deltaSignal);
  if (motionMode == 1) { rawMotion = max(deltaSignal, 0.0); }
  let motion = clamp(max(0.0, rawMotion - su.uMotionThreshold) * su.uMotionGain, 0.0, 1.0);

  let spawnDrive = clamp(
    su.uSourceInfluence * currentSignal + su.uMotionInfluence * motion,
    0.0,
    1.0,
  );
  let spawnProbability = 1.0
    - (1.0 - clamp(su.uAmbientSpawn, 0.0, 1.0)) * (1.0 - spawnDrive);
  let streamGate = select(0.0, 1.0, spawnNoise < spawnProbability);

  let fallCells = su.uFallSpeed * max(su.uDeltaSeconds, 0.0);
  let previousRow = cellIndex.y - fallCells;
  let previousUv = vec2<f32>(
    (cellIndex.x + 0.5) / stateSize.x,
    (previousRow + 0.5) / stateSize.y,
  );
  let previousRowWeight = clamp(previousRow + 1.0, 0.0, 1.0);
  // On a reset frame the previous state is stale/garbage, so ignore it.
  let advectedState = textureSample(
    uPrevState, uPrevStateSampler, clamp(previousUv, vec2<f32>(0.0), vec2<f32>(1.0))
  );
  let historyGate = previousRowWeight * (1.0 - su.uReset);
  let advectedRain = advectedState.r * historyGate;
  let advectedHead = advectedState.g * historyGate;

  let retention = exp2(-max(su.uDeltaSeconds, 0.0) / max(su.uTrailHalfLife, 1e-4));
  let sourceSurvival = exp2(
    -max(su.uDeltaSeconds, 0.0)
      * max(su.uDarkDamping, 0.0)
      * (1.0 - currentSignal),
  );
  let decayed = advectedRain * retention * sourceSurvival;
  let carriedHead = advectedHead * sourceSurvival;
  // Motion injection can bypass the procedural gate by motionImmediateAmount.
  let injectionGate = select(0.0, 1.0, su.uDeltaSeconds > 0.0);
  let trailGate = proceduralTrail * streamGate;
  let motionGate = streamGate
    * (proceduralTrail + (1.0 - proceduralTrail) * su.uMotionImmediateAmount);
  let baseInject = su.uBaseInjection * trailGate;
  let sourceInject = su.uSourceInfluence * currentSignal * trailGate;
  let motionInject = su.uMotionInfluence * motion * motionGate;
  let injection = clamp(
    (baseInject + sourceInject + motionInject)
      * su.uInjectionStrength * injectionGate,
    0.0,
    1.0
  );

  let dc = clamp(decayed, 0.0, 1.0);
  let ic = clamp(injection, 0.0, 1.0);
  let accumMode = i32(su.uAccumulationMode + 0.5);
  var nextRain = 1.0 - (1.0 - dc) * (1.0 - ic);
  if (accumMode == 1) {
    nextRain = max(dc, ic);
  } else if (accumMode == 2) {
    nextRain = clamp(dc + ic, 0.0, 1.0);
  }
  let headSeed = max(proceduralHead, headCrossed) * streamGate;
  let nextHead = max(carriedHead, headSeed);

  return vec4<f32>(nextRain, clamp(nextHead, 0.0, 1.0), currentSignal, clamp(motion, 0.0, 1.0));
}
`;
