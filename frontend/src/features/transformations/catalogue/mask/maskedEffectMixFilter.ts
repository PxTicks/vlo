import {
  Filter,
  GlProgram,
  Matrix,
  Sprite,
  Texture,
  UniformGroup,
} from "pixi.js";
import type { FilterSystem, RenderSurface } from "pixi.js";

const vertex = `
in vec2 aPosition;
out vec2 vTextureCoord;
out vec2 vEffectCoord;
out vec2 vCoverageCoord;

uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;
uniform mat3 uEffectFilterMatrix;
uniform mat3 uCoverageFilterMatrix;

vec4 filterVertexPosition(vec2 aPosition)
{
    vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;

    position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
    position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;

    return vec4(position, 0.0, 1.0);
}

vec2 filterTextureCoord(vec2 aPosition)
{
    return aPosition * (uOutputFrame.zw * uInputSize.zw);
}

void main(void)
{
    gl_Position = filterVertexPosition(aPosition);
    vTextureCoord = filterTextureCoord(aPosition);
    vEffectCoord = (uEffectFilterMatrix * vec3(vTextureCoord, 1.0)).xy;
    vCoverageCoord = (uCoverageFilterMatrix * vec3(vTextureCoord, 1.0)).xy;
}
`;

const SHARED_MASKED_EFFECT_MIX_PROGRAM = GlProgram.from({
  vertex,
  fragment: `
in vec2 vTextureCoord;
in vec2 vEffectCoord;
in vec2 vCoverageCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform sampler2D uEffectTexture;
uniform sampler2D uCoverageTexture;
uniform vec4 uInputClamp;
uniform vec4 uEffectClamp;
uniform vec4 uCoverageClamp;

void main(void)
{
    // All three textures are premultiplied; mixing in premultiplied space is a
    // well-defined cross-dissolve: exact for opaque input and correct (no alpha
    // over-accumulation) for transparent input. Coverage rides the red channel.
    vec4 base = texture(uTexture, clamp(vTextureCoord, uInputClamp.xy, uInputClamp.zw));
    vec4 effect = texture(uEffectTexture, clamp(vEffectCoord, uEffectClamp.xy, uEffectClamp.zw));
    float coverage = texture(uCoverageTexture, clamp(vCoverageCoord, uCoverageClamp.xy, uCoverageClamp.zw)).r;
    finalColor = mix(base, effect, coverage);
}
`,
  name: "masked-effect-mix-filter",
});

type MaskedEffectMixUniforms = UniformGroup<{
  uEffectFilterMatrix: { value: Matrix; type: "mat3x3<f32>" };
  uCoverageFilterMatrix: { value: Matrix; type: "mat3x3<f32>" };
  uEffectClamp: { value: Float32Array; type: "vec4<f32>" };
  uCoverageClamp: { value: Float32Array; type: "vec4<f32>" };
}>;

/**
 * Composites a masked effect in a single pass: `out = mix(input, effect,
 * coverage.r)`, where `input` is the filtered sprite's texture, and `effect`
 * (the full-texture effect output) and `coverage` (raw red-channel coverage
 * from `MaskTextureResolver.resolveCoverageTexture`) are bound as extra
 * samplers.
 *
 * Sampling `coverage.r` directly means NO red→alpha presentation pass is needed
 * (unlike the AlphaMask path), and mixing in premultiplied space gives exact
 * `mix` for any source alpha. Both extra textures are aligned to the filtered
 * input via Pixi's sprite-matrix calculation against a reference sprite, exactly
 * like `MaskBooleanBlendFilter` aligns its left operand.
 */
export class MaskedEffectMixFilter extends Filter {
  private effectTexture: Texture = Texture.EMPTY;
  private coverageTexture: Texture = Texture.EMPTY;
  private readonly referenceSprite: Sprite;

  constructor(referenceSprite: Sprite) {
    super({
      glProgram: SHARED_MASKED_EFFECT_MIX_PROGRAM,
      resources: {
        filterUniforms: new UniformGroup({
          uEffectFilterMatrix: { value: new Matrix(), type: "mat3x3<f32>" },
          uCoverageFilterMatrix: { value: new Matrix(), type: "mat3x3<f32>" },
          uEffectClamp: {
            value: new Float32Array([0, 0, 1, 1]),
            type: "vec4<f32>",
          },
          uCoverageClamp: {
            value: new Float32Array([0, 0, 1, 1]),
            type: "vec4<f32>",
          },
        }),
        uEffectTexture: Texture.EMPTY.source,
        uCoverageTexture: Texture.EMPTY.source,
      },
    });

    this.referenceSprite = referenceSprite;
  }

  public setEffectTexture(texture: Texture): void {
    this.effectTexture = texture;
  }

  public setCoverageTexture(texture: Texture): void {
    this.coverageTexture = texture;
  }

  public apply(
    filterManager: FilterSystem,
    input: Texture,
    output: RenderSurface,
    clearMode: boolean,
  ): void {
    const uniforms = (this.resources.filterUniforms as MaskedEffectMixUniforms)
      .uniforms;

    const effectMatrix = this.effectTexture.textureMatrix;
    effectMatrix.update();
    filterManager
      .calculateSpriteMatrix(uniforms.uEffectFilterMatrix, this.referenceSprite)
      .prepend(effectMatrix.mapCoord);
    uniforms.uEffectClamp.set(effectMatrix.uClampFrame);

    const coverageMatrix = this.coverageTexture.textureMatrix;
    coverageMatrix.update();
    filterManager
      .calculateSpriteMatrix(
        uniforms.uCoverageFilterMatrix,
        this.referenceSprite,
      )
      .prepend(coverageMatrix.mapCoord);
    uniforms.uCoverageClamp.set(coverageMatrix.uClampFrame);

    this.resources.uEffectTexture = this.effectTexture.source;
    this.resources.uCoverageTexture = this.coverageTexture.source;
    filterManager.applyFilter(this, input, output, clearMode);
  }
}

export function createMaskedEffectMixFilter(
  referenceSprite: Sprite,
): MaskedEffectMixFilter {
  return new MaskedEffectMixFilter(referenceSprite);
}
