import {
  MASK_DISTANCE_LEVELS_PER_PIXEL,
  MASK_DISTANCE_ZERO_LEVEL,
} from "../../model/maskAssetEncoding";

/**
 * GLSL for the distance-field mask edge passes (see MaskDistanceFieldRenderer).
 *
 * Every pass draws a full-target quad and addresses texels with `texelFetch`
 * at `gl_FragCoord`, so the source and target textures must share a size and
 * no pass depends on Pixi's projection or filter frames. Seed textures pack
 * one boundary point per texel: x and y as 16-bit fixed point split across
 * RG and BA, with 0xFFFF marking "no seed".
 */

// `#version 300 es` opts the program into GLSL ES 3.00 (Pixi otherwise
// compiles ES 1.00, which has no texelFetch). The leading precision line
// keeps Pixi from injecting its default mediump, which cannot hold packed
// coordinates.
const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`;

const SEED_CODEC = `
uniform float uSeedScale;

vec4 encodeSeed(vec2 seed)
{
    vec2 fixedPoint = clamp(floor(seed * uSeedScale + 0.5), 0.0, 65534.0);
    vec2 high = floor(fixedPoint / 256.0);
    vec2 low = fixedPoint - high * 256.0;
    return vec4(high.x, low.x, high.y, low.y) / 255.0;
}

const vec4 NO_SEED = vec4(1.0);

bool decodeSeed(vec4 texel, out vec2 seed)
{
    vec4 bytes = floor(texel * 255.0 + 0.5);
    vec2 fixedPoint = vec2(bytes.r * 256.0 + bytes.g, bytes.b * 256.0 + bytes.a);
    seed = fixedPoint / uSeedScale;
    return fixedPoint.x < 65535.0;
}
`;

/** Decodes a distance-band texel (red) to signed texels, negative inside. */
const FIELD_CODEC = `
float fieldDistance(float red)
{
    return (${MASK_DISTANCE_ZERO_LEVEL.toFixed(1)} - red * 255.0) / ${MASK_DISTANCE_LEVELS_PER_PIXEL.toFixed(1)};
}
`;

export const DISTANCE_FIELD_VERTEX = `#version 300 es
precision highp float;
in vec2 aPosition;

void main(void)
{
    gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

/**
 * Finds, for each texel on the mask boundary, the nearest point where the
 * boundary crosses one of its four edges.
 *
 * From coverage, inside/outside comes from the raw coverage (>= 0.5) and the
 * crossing position from coverage smoothed by a [1 2 1] binomial
 * (sigma ~0.7), which places a hard-edged mask's boundary between its pixel
 * steps instead of on them. Thin features whose smoothed coverage never
 * crosses 0.5 clamp to the texel centre rather than vanish.
 *
 * From a distance band the boundary is the band's zero crossing, already
 * sub-pixel: the crossing is linear in the two distances, with no smoothing.
 * A true distance changes by at most one per texel, so a larger step is a
 * discontinuity (the band meeting an uncovered border), not a crossing to
 * interpolate; its edge sits halfway, as a hard-edged mask's would.
 */
export const DISTANCE_FIELD_SEED_FRAGMENT = `${HEADER}
uniform sampler2D uSource;
uniform vec2 uSize;
uniform float uSourceIsField;
${SEED_CODEC}
${FIELD_CODEC}
// One texel of true distance change, plus headroom for the band's codec error.
const float MAX_FIELD_STEP = 1.5;
out vec4 finalColor;

float coverageAt(ivec2 texel)
{
    // Clamping to the border means the content edge is never a mask edge.
    ivec2 clamped = clamp(texel, ivec2(0), ivec2(uSize) - ivec2(1));
    return texelFetch(uSource, clamped, 0).r;
}

float neighbourhood[25];

float rawAt(ivec2 offset)
{
    return neighbourhood[(offset.y + 2) * 5 + offset.x + 2];
}

float smoothedAt(ivec2 offset)
{
    float sum = 0.0;
    for (int dy = -1; dy <= 1; dy++) {
        float wy = dy == 0 ? 2.0 : 1.0;
        for (int dx = -1; dx <= 1; dx++) {
            float wx = dx == 0 ? 2.0 : 1.0;
            sum += wx * wy * rawAt(offset + ivec2(dx, dy));
        }
    }
    return sum / 16.0;
}

void main(void)
{
    ivec2 texel = ivec2(gl_FragCoord.xy);
    for (int dy = -2; dy <= 2; dy++) {
        for (int dx = -2; dx <= 2; dx++) {
            neighbourhood[(dy + 2) * 5 + dx + 2] = coverageAt(texel + ivec2(dx, dy));
        }
    }

    bool fromField = uSourceIsField > 0.5;
    float fieldHere = fieldDistance(rawAt(ivec2(0)));
    bool inside = fromField ? fieldHere < 0.0 : rawAt(ivec2(0)) >= 0.5;
    float smoothedHere = smoothedAt(ivec2(0));
    vec2 centre = vec2(texel) + 0.5;
    ivec2 size = ivec2(uSize);

    float bestT = 2.0;
    vec2 bestSeed = centre;
    for (int i = 0; i < 4; i++) {
        ivec2 offset = i == 0 ? ivec2(1, 0)
            : i == 1 ? ivec2(-1, 0)
            : i == 2 ? ivec2(0, 1)
            : ivec2(0, -1);
        ivec2 neighbour = texel + offset;
        if (any(lessThan(neighbour, ivec2(0))) || any(greaterThanEqual(neighbour, size))) {
            continue;
        }
        float t;
        if (fromField) {
            float fieldThere = fieldDistance(rawAt(offset));
            if ((fieldThere < 0.0) == inside) {
                continue;
            }
            float fieldStep = fieldHere - fieldThere;
            t = abs(fieldStep) <= MAX_FIELD_STEP ? fieldHere / fieldStep : 0.5;
        } else {
            if ((rawAt(offset) >= 0.5) == inside) {
                continue;
            }
            float smoothedThere = smoothedAt(offset);
            float difference = smoothedHere - smoothedThere;
            t = abs(difference) > 1e-6 ? (smoothedHere - 0.5) / difference : 0.5;
        }
        t = clamp(t, 0.0, 1.0);
        if (t < bestT) {
            bestT = t;
            bestSeed = centre + t * vec2(offset);
        }
    }

    finalColor = bestT <= 1.0 ? encodeSeed(bestSeed) : NO_SEED;
}
`;

/** One jump-flood step: keep the nearest seed among the 3x3 at +-uStep. */
export const DISTANCE_FIELD_FLOOD_FRAGMENT = `${HEADER}
uniform sampler2D uSeeds;
uniform vec2 uSize;
uniform float uStep;
${SEED_CODEC}
out vec4 finalColor;

void main(void)
{
    ivec2 texel = ivec2(gl_FragCoord.xy);
    ivec2 size = ivec2(uSize);
    int stride = int(uStep);
    vec2 centre = vec2(texel) + 0.5;

    bool found = false;
    float bestSquaredDistance = 0.0;
    vec2 bestSeed = vec2(0.0);
    for (int dy = -1; dy <= 1; dy++) {
        for (int dx = -1; dx <= 1; dx++) {
            ivec2 neighbour = texel + ivec2(dx, dy) * stride;
            if (any(lessThan(neighbour, ivec2(0))) || any(greaterThanEqual(neighbour, size))) {
                continue;
            }
            vec2 seed;
            if (!decodeSeed(texelFetch(uSeeds, neighbour, 0), seed)) {
                continue;
            }
            vec2 delta = seed - centre;
            float squaredDistance = dot(delta, delta);
            if (!found || squaredDistance < bestSquaredDistance) {
                found = true;
                bestSquaredDistance = squaredDistance;
                bestSeed = seed;
            }
        }
    }

    finalColor = found ? encodeSeed(bestSeed) : NO_SEED;
}
`;

/**
 * Turns a signed distance (negative inside) into coverage: offset by the
 * grow, then a smoothstep ramp over the feather interval. Output matches the
 * other mask passes: coverage in every channel.
 *
 * The distance comes from the nearest seed, signed by the source coverage
 * (uDistanceSource 0) or by the source distance band (2), or is read from
 * the band directly when the ramp stays inside it (1).
 */
export const DISTANCE_FIELD_SHAPE_FRAGMENT = `${HEADER}
uniform sampler2D uSeeds;
uniform sampler2D uSource;
uniform float uDistanceSource;
uniform float uOffset;
uniform float uSign;
uniform float uRampStart;
uniform float uRampEnd;
uniform float uInvertOutput;
${SEED_CODEC}
${FIELD_CODEC}
out vec4 finalColor;

void main(void)
{
    ivec2 texel = ivec2(gl_FragCoord.xy);
    vec2 centre = vec2(texel) + 0.5;
    float source = texelFetch(uSource, texel, 0).r;

    float signedDistance;
    if (uDistanceSource > 0.5 && uDistanceSource < 1.5) {
        signedDistance = fieldDistance(source);
    } else {
        bool inside = uDistanceSource > 1.5 ? fieldDistance(source) < 0.0 : source >= 0.5;
        // With no seed in reach the texel is farther than any ramp extends.
        vec2 seed;
        float seedDistance = decodeSeed(texelFetch(uSeeds, texel, 0), seed)
            ? length(seed - centre)
            : 1.0e6;
        signedDistance = inside ? -seedDistance : seedDistance;
    }
    float edge = uSign * (signedDistance - uOffset);
    float t = clamp((edge - uRampStart) / (uRampEnd - uRampStart), 0.0, 1.0);
    float coverage = 1.0 - t * t * (3.0 - 2.0 * t);
    if (uInvertOutput > 0.5) {
        coverage = 1.0 - coverage;
    }
    finalColor = vec4(coverage);
}
`;
