import {
  ColorMatrixFilter,
  Filter,
  type Sprite,
  type Texture,
} from "pixi.js";

export interface OutputTransformContext {
  sprite: Sprite;
  sourceTexture: Texture;
}

export type OutputTransform = ((context: OutputTransformContext) => void) | null;

export function resetOutputSprite(sprite: Sprite, sourceTexture: Texture): void {
  sprite.texture = sourceTexture;
  sprite.filters = null;
  sprite.visible = true;
  sprite.alpha = 1;
  sprite.tint = 0xffffff;
  sprite.blendMode = "normal";
}

export function applyOutputTransformStack(
  sprite: Sprite,
  sourceTexture: Texture,
  transformStack?: OutputTransform[],
): void {
  resetOutputSprite(sprite, sourceTexture);
  if (!transformStack || transformStack.length === 0) {
    return;
  }
  for (const transform of transformStack) {
    if (!transform) continue;
    transform({ sprite, sourceTexture });
  }
}

export function createFilterStackTransform(
  filters: Filter[] | null,
): OutputTransform {
  return ({ sprite }) => {
    sprite.filters = filters;
  };
}

const defaultVertex = `
in vec2 aPosition;
out vec2 vTextureCoord;

uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

vec4 filterVertexPosition( void )
{
    vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
    
    position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
    position.y = position.y * (2.0*uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;

    return vec4(position, 0.0, 1.0);
}

vec2 filterTextureCoord( void )
{
    return aPosition * (uOutputFrame.zw * uInputSize.zw);
}

void main(void)
{
    gl_Position = filterVertexPosition();
    vTextureCoord = filterTextureCoord();
}
`;

const binaryMaskFragment = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;

void main(void)
{
    float alpha = texture(uTexture, vTextureCoord).a;
    // Binary matte:
    // alpha < 0.05 -> white (background / transparent)
    // alpha >= 0.05 -> black (foreground / opaque)
    float value = alpha < 0.05 ? 1.0 : 0.0;
    finalColor = vec4(value, value, value, 1.0);
}
`;

/**
 * Binary mask filter used for export mattes.
 * Keeps only highly transparent pixels as white to suppress subpixel edge halos.
 */
export function createBinaryMaskOutputFilter(): Filter {
  return Filter.from({
    gl: {
      vertex: defaultVertex,
      fragment: binaryMaskFragment,
    },
  });
}

/**
 * Non-binary alpha-to-grayscale mask mapping.
 * Useful for future feathered / soft masks where retaining edge gradients is desired.
 */
export function createNonBinaryMaskOutputColorMatrixFilter(): ColorMatrixFilter {
  const filter = new ColorMatrixFilter();
  // Transparent pixels -> white, opaque pixels -> black (with grayscale falloff).
  filter.matrix = [
    0, 0, 0, -1, 1,
    0, 0, 0, -1, 1,
    0, 0, 0, -1, 1,
    0, 0, 0, 0, 1,
  ];
  return filter;
}

export function createTransparentAreaNeutralGrayOutputColorMatrixFilter(): ColorMatrixFilter {
  const filter = new ColorMatrixFilter();
  // Export textures are premultiplied, so adding 0.5 * (1 - alpha) composites
  // the transparent region over a neutral gray matte and forces full opacity.
  filter.matrix = [
    1, 0, 0, -0.5, 0.5,
    0, 1, 0, -0.5, 0.5,
    0, 0, 1, -0.5, 0.5,
    0, 0, 0, 0, 1,
  ];
  return filter;
}

export function createOpaqueOutputColorMatrixFilter(): ColorMatrixFilter {
  const filter = new ColorMatrixFilter();
  filter.matrix = [
    1, 0, 0, 0, 0,
    0, 1, 0, 0, 0,
    0, 0, 1, 0, 0,
    0, 0, 0, 0, 1,
  ];
  return filter;
}
