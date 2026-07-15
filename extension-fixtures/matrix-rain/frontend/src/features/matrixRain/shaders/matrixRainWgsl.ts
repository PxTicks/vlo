import { GLYPH_STROKE_MASKS } from "../utils/matrixRainMath";

/**
 * WebGPU (WGSL) program for the stateless Phase 2 Matrix appearance. It is a
 * line-for-line mirror of `matrixRainGl.ts` using Pixi v8's filter binding
 * convention: global filter uniforms + input texture/sampler at `@group(0)`,
 * and this filter's own uniform struct at `@group(1) @binding(0)`.
 *
 * The `MatrixRainUniforms` struct field order MUST match the JS uniform
 * insertion order in `MatrixRainFilter.ts`; Pixi computes the UBO byte layout
 * from that order using the same alignment rules WGSL applies to the struct, so
 * the two agree without manual padding.
 */

export const MATRIX_RAIN_WGSL_VERTEX_ENTRY = "mainVertex";
export const MATRIX_RAIN_WGSL_FRAGMENT_ENTRY = "mainFragment";

const GLYPH_ARRAY = GLYPH_STROKE_MASKS.map((mask) => `${mask >>> 0}u`).join(", ");

export const MATRIX_RAIN_WGSL = `
struct GlobalFilterUniforms {
  uInputSize: vec4<f32>,
  uInputPixel: vec4<f32>,
  uInputClamp: vec4<f32>,
  uOutputFrame: vec4<f32>,
  uGlobalFrame: vec4<f32>,
  uOutputTexture: vec4<f32>,
};

struct MatrixRainUniforms {
  uTimeSeconds: f32,
  uSize: f32,
  uVerticalSpacing: f32,
  uSeed: f32,
  uGlyphCycleRate: f32,
  uFallSpeed: f32,
  uSpeedVariation: f32,
  uTrailShape: f32,
  uPulseDensity: f32,
  uHeadWidth: f32,
  uRainStrength: f32,
  uHeadIntensity: f32,
  uDitherMagnitude: f32,
  uOutputMode: f32,
  uDebugMode: f32,
  uContentSize: vec2<f32>,
  uBackground: vec3<f32>,
  uShadow: vec3<f32>,
  uBody: vec3<f32>,
  uBright: vec3<f32>,
  uHead: vec3<f32>,
};

@group(0) @binding(0) var<uniform> gfu: GlobalFilterUniforms;
@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var uSampler: sampler;
@group(1) @binding(0) var<uniform> matrixRainUniforms: MatrixRainUniforms;

var<private> GLYPHS: array<u32, 16> = array<u32, 16>(${GLYPH_ARRAY});
var<private> SEGMENT_A: array<vec2<f32>, 16> = array<vec2<f32>, 16>(
  vec2<f32>(0.22, 0.14), vec2<f32>(0.30, 0.34), vec2<f32>(0.18, 0.50), vec2<f32>(0.30, 0.66),
  vec2<f32>(0.22, 0.86), vec2<f32>(0.20, 0.15), vec2<f32>(0.80, 0.15), vec2<f32>(0.50, 0.12),
  vec2<f32>(0.22, 0.15), vec2<f32>(0.78, 0.15), vec2<f32>(0.50, 0.15), vec2<f32>(0.50, 0.15),
  vec2<f32>(0.20, 0.50), vec2<f32>(0.80, 0.50), vec2<f32>(0.50, 0.15), vec2<f32>(0.50, 0.50),
);
var<private> SEGMENT_B: array<vec2<f32>, 16> = array<vec2<f32>, 16>(
  vec2<f32>(0.78, 0.14), vec2<f32>(0.70, 0.34), vec2<f32>(0.82, 0.50), vec2<f32>(0.70, 0.66),
  vec2<f32>(0.78, 0.86), vec2<f32>(0.20, 0.85), vec2<f32>(0.80, 0.85), vec2<f32>(0.50, 0.88),
  vec2<f32>(0.78, 0.85), vec2<f32>(0.22, 0.85), vec2<f32>(0.20, 0.50), vec2<f32>(0.80, 0.50),
  vec2<f32>(0.50, 0.85), vec2<f32>(0.50, 0.85), vec2<f32>(0.50, 0.50), vec2<f32>(0.50, 0.85),
);

fn pcgHash(v: u32) -> u32 {
  let state = v * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
fn hash2(a: u32, b: u32) -> u32 { return pcgHash(a ^ pcgHash(b)); }
fn hash3(a: u32, b: u32, c: u32) -> u32 { return pcgHash(a ^ hash2(b, c)); }
fn unitFloat(h: u32) -> f32 { return f32(h & 0x00ffffffu) / 16777216.0; }

fn segmentDistance(p: vec2<f32>, a: vec2<f32>, b: vec2<f32>) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

fn glyphCoverage(glyphIndex: u32, uv: vec2<f32>) -> f32 {
  let strokeMask = GLYPHS[glyphIndex];
  var distanceToStroke = 10.0;
  for (var segment = 0u; segment < 16u; segment += 1u) {
    let segmentBit = 1u << segment;
    if ((strokeMask & segmentBit) != 0u) {
      distanceToStroke = min(
        distanceToStroke,
        segmentDistance(uv, SEGMENT_A[segment], SEGMENT_B[segment]),
      );
    }
  }
  let antialias = max(fwidth(distanceToStroke), 0.0015);
  return 1.0 - smoothstep(
    0.055 - antialias,
    0.055 + antialias,
    distanceToStroke,
  );
}

fn paletteGrade(bIn: f32) -> vec3<f32> {
  let b = clamp(bIn, 0.0, 1.0);
  if (b <= 0.5) {
    return mix(matrixRainUniforms.uShadow, matrixRainUniforms.uBody, b / 0.5);
  }
  return mix(matrixRainUniforms.uBody, matrixRainUniforms.uBright, (b - 0.5) / 0.5);
}

fn filterVertexPosition(aPosition: vec2<f32>) -> vec4<f32> {
  var position = aPosition * gfu.uOutputFrame.zw + gfu.uOutputFrame.xy;
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
};

@vertex
fn mainVertex(@location(0) aPosition: vec2<f32>) -> VSOutput {
  return VSOutput(filterVertexPosition(aPosition), filterTextureCoord(aPosition));
}

@fragment
fn mainFragment(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let mu = matrixRainUniforms;
  let outMode = i32(mu.uOutputMode + 0.5);
  let dbgMode = i32(mu.uDebugMode + 0.5);

  let frameSize = max(gfu.uOutputFrame.zw, vec2<f32>(1.0));
  var contentSize = mu.uContentSize;
  if (contentSize.x <= 0.0 || contentSize.y <= 0.0) {
    contentSize = frameSize;
  }
  let pixel = uv * gfu.uInputSize.xy * (contentSize / frameSize);
  let size = max(mu.uSize, 1.0);
  let rowPitch = size + max(mu.uVerticalSpacing, 0.0);
  let cellIndex = vec2<f32>(floor(pixel.x / size), floor(pixel.y / rowPitch));
  let rowPixel = pixel.y - rowPitch * floor(pixel.y / rowPitch);
  let sub = vec2<f32>(fract(pixel.x / size), rowPixel / size);
  let glyphRegion = select(0.0, 1.0, sub.y < 1.0);
  let col = u32(max(cellIndex.x, 0.0));
  let row = u32(max(cellIndex.y, 0.0));
  let seed = u32(max(mu.uSeed, 0.0));

  let spacing = clamp(22.0 / max(mu.uPulseDensity, 1e-4), 4.0, 512.0);
  let speedRandom = unitFloat(hash2(col * 2u + 1u, seed));
  let phase = unitFloat(hash2(col * 2u, seed));
  let speed = mu.uFallSpeed * (1.0 - mu.uSpeedVariation * speedRandom);
  let headLine = phase * spacing + mu.uTimeSeconds * speed;
  var d = headLine - f32(row);
  d = d - spacing * floor(d / spacing);
  let fade = max(0.0, 1.0 - d / spacing);
  let trail = pow(fade, max(mu.uTrailShape, 1e-3)) * mu.uRainStrength;
  let headEdge = max(mu.uHeadWidth, 1e-4);
  let head = 1.0 - smoothstep(0.0, headEdge, d / spacing);

  let bucket = u32(floor(max(mu.uTimeSeconds, 0.0) * mu.uGlyphCycleRate));
  let gi = hash3(col, row, bucket ^ seed) % 16u;
  let lit = glyphCoverage(gi, sub) * glyphRegion;

  if (dbgMode == 1) {
    let border = select(0.0, 1.0, sub.x < 0.06 || sub.y < 0.06);
    let grid = mix(vec3<f32>(0.0, 0.15, 0.0), vec3<f32>(0.0, 0.6, 0.0), border);
    return vec4<f32>(grid + vec3<f32>(0.0, lit * 0.5, 0.0), 1.0);
  }
  if (dbgMode == 2) {
    return vec4<f32>(0.0, clamp(trail, 0.0, 1.0), 0.0, 1.0);
  }
  if (dbgMode == 3) {
    return vec4<f32>(clamp(head, 0.0, 1.0) * vec3<f32>(0.6, 1.0, 0.75), 1.0);
  }

  let bodyB = clamp(trail, 0.0, 1.0) * lit;
  let headB = head * mu.uHeadIntensity * lit;
  let coverage = clamp(bodyB + headB, 0.0, 1.0);
  let grade = paletteGrade(trail);
  // Static per-pixel dither scaled by coverage: the flat background never
  // shimmers and stays exactly uBackground; transparent output stays clear.
  let dither = (unitFloat(hash2(u32(pixel.x), u32(pixel.y))) - 0.5)
    * mu.uDitherMagnitude * coverage;

  if (outMode == 1) {
    // matrixOnly: dither the straight colour, then premultiply by coverage so no
    // channel can exceed alpha (no bright compositing fringe).
    let straight = clamp(
      grade + mu.uHead * head * mu.uHeadIntensity + vec3<f32>(dither),
      vec3<f32>(0.0),
      vec3<f32>(1.0),
    );
    return vec4<f32>(straight * coverage, coverage);
  }
  let rgb = mix(mu.uBackground, grade, bodyB) + mu.uHead * headB + vec3<f32>(dither);
  return vec4<f32>(rgb, 1.0);
}
`;
