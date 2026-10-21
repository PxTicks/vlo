import {
  Filter,
  GlProgram,
  Matrix,
  Sprite,
  Texture,
  UniformGroup,
} from "pixi.js";
import type { FilterSystem, RenderSurface } from "pixi.js";
import type { MaskBooleanOperator } from "../../../../types/TimelineTypes";

const defaultVertex = `
in vec2 aPosition;
out vec2 vTextureCoord;
out vec2 vLeftCoord;

uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;
uniform mat3 uLeftFilterMatrix;

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

vec2 getLeftCoord(vec2 aPosition)
{
    return (uLeftFilterMatrix * vec3(filterTextureCoord(aPosition), 1.0)).xy;
}

void main(void)
{
    gl_Position = filterVertexPosition(aPosition);
    vTextureCoord = filterTextureCoord(aPosition);
    vLeftCoord = getLeftCoord(aPosition);
}
`;

const SHARED_MASK_BOOLEAN_BLEND_PROGRAM = GlProgram.from({
  vertex: defaultVertex,
  fragment: `
in vec2 vTextureCoord;
in vec2 vLeftCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform sampler2D uLeftTexture;
uniform vec4 uInputClamp;
uniform vec4 uLeftClamp;
uniform float uOperator;
uniform float uOperateOnInverseCoverage;

float readMaskField(sampler2D maskTexture, vec2 uv, vec4 clampFrame)
{
    float clip = step(3.5,
        step(clampFrame.x, uv.x) +
        step(clampFrame.y, uv.y) +
        step(uv.x, clampFrame.z) +
        step(uv.y, clampFrame.w));

    return texture(maskTexture, clamp(uv, clampFrame.xy, clampFrame.zw)).r * clip;
}

float applyMaskBooleanOperator(float leftLevel, float rightLevel)
{
    // Bright means inside (level = 127.5 - 8*d): min distance is max
    // level, and negating a distance complements its level exactly.
    if (uOperator < 0.5) return max(leftLevel, rightLevel);
    if (uOperator < 1.5) return min(leftLevel, rightLevel);
    return min(leftLevel, 1.0 - rightLevel);
}

void main(void)
{
    float leftLevel = readMaskField(uLeftTexture, vLeftCoord, uLeftClamp);
    float rightLevel = readMaskField(uTexture, vTextureCoord, uInputClamp);
    float level = applyMaskBooleanOperator(leftLevel, rightLevel);

    if (uOperateOnInverseCoverage == 1.0) {
        level = 1.0 - applyMaskBooleanOperator(
            1.0 - leftLevel,
            1.0 - rightLevel
        );
    }

    finalColor = vec4(vec3(level), 1.0);
}
`,
  name: "mask-boolean-blend-filter",
});

function getOperatorUniformValue(operator: MaskBooleanOperator): number {
  switch (operator) {
    case "union":
      return 0;
    case "intersect":
      return 1;
    case "subtract":
      return 2;
  }
}

type MaskBooleanFilterUniforms = UniformGroup<{
  uLeftFilterMatrix: { value: Matrix; type: "mat3x3<f32>" };
  uLeftClamp: { value: Float32Array; type: "vec4<f32>" };
  uOperator: { value: number; type: "f32" };
  uOperateOnInverseCoverage: { value: number; type: "f32" };
}>;

/**
 * Combines encoded signed-distance bands. Aligns the left-hand operand with
 * the filtered input texture using Pixi's sprite-matrix calculation. This keeps
 * both operands in the same coordinate space even when the filter system pads
 * or offsets the temporary input frame.
 */
export class MaskBooleanBlendFilter extends Filter {
  private leftTexture: Texture = Texture.EMPTY;
  private readonly referenceSprite: Sprite;

  constructor(operator: MaskBooleanOperator, referenceSprite: Sprite) {
    super({
      glProgram: SHARED_MASK_BOOLEAN_BLEND_PROGRAM,
      resources: {
        filterUniforms: new UniformGroup({
          uLeftFilterMatrix: {
            value: new Matrix(),
            type: "mat3x3<f32>",
          },
          uLeftClamp: {
            value: new Float32Array([0, 0, 1, 1]),
            type: "vec4<f32>",
          },
          uOperator: {
            value: getOperatorUniformValue(operator),
            type: "f32",
          },
          uOperateOnInverseCoverage: {
            value: 0,
            type: "f32",
          },
        }),
        uLeftTexture: Texture.EMPTY.source,
      },
    });

    this.referenceSprite = referenceSprite;
  }

  public setLeftTexture(texture: Texture) {
    this.leftTexture = texture;
  }

  public setOperateOnInverseCoverage(value: boolean) {
    const filterUniforms = this.resources
      .filterUniforms as MaskBooleanFilterUniforms;
    filterUniforms.uniforms.uOperateOnInverseCoverage = value ? 1 : 0;
  }

  public apply(
    filterManager: FilterSystem,
    input: Texture,
    output: RenderSurface,
    clearMode: boolean,
  ) {
    const leftTextureMatrix = this.leftTexture.textureMatrix;
    leftTextureMatrix.update();

    const filterUniforms = this.resources
      .filterUniforms as MaskBooleanFilterUniforms;
    const uniforms = filterUniforms.uniforms;

    filterManager
      .calculateSpriteMatrix(uniforms.uLeftFilterMatrix, this.referenceSprite)
      .prepend(leftTextureMatrix.mapCoord);
    uniforms.uLeftClamp.set(leftTextureMatrix.uClampFrame);

    this.resources.uLeftTexture = this.leftTexture.source;
    filterManager.applyFilter(this, input, output, clearMode);
  }
}

export function createMaskBooleanBlendFilter(
  operator: MaskBooleanOperator,
  referenceSprite: Sprite,
): MaskBooleanBlendFilter {
  return new MaskBooleanBlendFilter(operator, referenceSprite);
}
