/**
 * WebGPU (WGSL) state-update program for Phase 3 temporal feedback. A
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
  uTrailHalfLife: f32,
  uBaseInjection: f32,
  uSourceInfluence: f32,
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

  let sourcePixel = vec2<f32>(
    (cellIndex.x + 0.5) * size,
    (cellIndex.y + 0.5) * rowPitch,
  );
  let sourceUv = sourcePixel * (frameSize / contentSize) * gfu.uInputSize.zw;
  let src = textureSample(
    uTexture,
    uSampler,
    clamp(sourceUv, gfu.uInputClamp.xy, gfu.uInputClamp.zw),
  );
  var rgb = src.rgb;
  if (src.a > 0.0) { rgb = src.rgb / src.a; }
  let currentSignal = clamp(dot(rgb, vec3<f32>(0.2126, 0.7152, 0.0722)), 0.0, 1.0);

  let fallCells = su.uFallSpeed * max(su.uDeltaSeconds, 0.0);
  let previousRow = cellIndex.y - fallCells;
  let previousUv = vec2<f32>(
    (cellIndex.x + 0.5) / stateSize.x,
    (previousRow + 0.5) / stateSize.y,
  );
  let previousRowWeight = clamp(previousRow + 1.0, 0.0, 1.0);
  // On a reset frame the previous state is stale/garbage, so ignore it.
  let advectedRain = textureSample(
    uPrevState, uPrevStateSampler, clamp(previousUv, vec2<f32>(0.0), vec2<f32>(1.0))
  ).r * previousRowWeight * (1.0 - su.uReset);

  let retention = exp2(-max(su.uDeltaSeconds, 0.0) / max(su.uTrailHalfLife, 1e-4));
  let decayed = advectedRain * retention;
  let injectionGate = select(0.0, 1.0, su.uDeltaSeconds > 0.0);
  let injection = clamp(
    (su.uBaseInjection + su.uSourceInfluence * currentSignal * proceduralTrail)
      * injectionGate,
    0.0,
    1.0
  );
  let nextRain = 1.0 - (1.0 - clamp(decayed, 0.0, 1.0)) * (1.0 - injection);

  return vec4<f32>(nextRain, clamp(proceduralHead, 0.0, 1.0), currentSignal, 0.0);
}
`;
