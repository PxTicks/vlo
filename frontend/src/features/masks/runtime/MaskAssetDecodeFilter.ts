import { Filter, GlProgram, UniformGroup } from "pixi.js";
import type { MaskAssetEncoding } from "../../../types/Asset";
import {
  MASK_DISTANCE_LEVELS_PER_PIXEL,
  MASK_DISTANCE_ZERO_LEVEL,
} from "../model/maskAssetEncoding";

const vertex = `
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

const ZERO_LEVEL = MASK_DISTANCE_ZERO_LEVEL.toFixed(1);
const LEVELS_PER_PIXEL = MASK_DISTANCE_LEVELS_PER_PIXEL.toFixed(1);

const fragment = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform float uMode;
uniform float uDistanceScale;

void main(void)
{
    // Red is the canonical runtime mask channel; sampled alpha reads 1.0 for
    // non-alpha video textures, so coverage is rewritten into every channel.
    float red = texture(uTexture, vTextureCoord).r;
    if (uMode < 0.5) {
        // Binary assets pass through: a brush PNG's anti-aliasing is real
        // coverage, and edge ops cut at the unbiased 0.5.
        finalColor = vec4(red);
        return;
    }
    float level = red * 255.0;

    // Distance band: signed distance in output texels, negative inside.
    float signedDistance = (${ZERO_LEVEL} - level) / ${LEVELS_PER_PIXEL} * uDistanceScale;
    if (uMode < 1.5) {
        // Anti-aliased coverage, the same one-texel edge the shaping pass draws.
        float t = clamp(signedDistance + 0.5, 0.0, 1.0);
        finalColor = vec4(1.0 - t * t * (3.0 - 2.0 * t));
        return;
    }

    // The band re-encoded in output texels, for distance-field edge ops.
    finalColor = vec4(
        clamp(${ZERO_LEVEL} - ${LEVELS_PER_PIXEL} * signedDistance, 0.0, 255.0) / 255.0
    );
}
`;

const MASK_ASSET_DECODE_PROGRAM = GlProgram.from({
  vertex,
  fragment,
  name: "mask-asset-decode-filter",
});

export type MaskAssetDecodeOutput = "coverage" | "distance_field";

type MaskAssetDecodeUniforms = UniformGroup<{
  uMode: { value: number; type: "f32" };
  uDistanceScale: { value: number; type: "f32" };
}>;

/**
 * Decodes an asset mask's frames for the mask compositor. Binary assets pass
 * their red coverage through; distance-band assets (`tsdf8_k8`) render
 * anti-aliased coverage, or, for distance-field edge ops, their distance
 * band re-encoded in output texels.
 *
 * It sits on the node's root container, not on the frame sprite:
 * `applyClipTransforms` owns the sprite's filter list and destroys any filter
 * it did not create.
 */
export class MaskAssetDecodeFilter extends Filter {
  private currentEncoding: MaskAssetEncoding = "binary";
  private currentOutput: MaskAssetDecodeOutput = "coverage";

  constructor() {
    super({
      glProgram: MASK_ASSET_DECODE_PROGRAM,
      resources: {
        maskDecodeUniforms: new UniformGroup({
          uMode: { value: 0, type: "f32" },
          uDistanceScale: { value: 1, type: "f32" },
        }),
      },
    });
  }

  public get encoding(): MaskAssetEncoding {
    return this.currentEncoding;
  }

  public setEncoding(encoding: MaskAssetEncoding): void {
    this.currentEncoding = encoding;
    this.syncMode();
  }

  /** Only distance-band assets have a distance field to output. */
  public setOutput(output: MaskAssetDecodeOutput): void {
    this.currentOutput = output;
    this.syncMode();
  }

  /** Output texels per asset pixel, so distances land in output texels. */
  public setDistanceScale(texelsPerAssetPixel: number): void {
    this.uniformGroup.uniforms.uDistanceScale =
      Number.isFinite(texelsPerAssetPixel) && texelsPerAssetPixel > 0
        ? texelsPerAssetPixel
        : 1;
  }

  private get uniformGroup(): MaskAssetDecodeUniforms {
    return this.resources.maskDecodeUniforms as MaskAssetDecodeUniforms;
  }

  private syncMode(): void {
    this.uniformGroup.uniforms.uMode =
      this.currentEncoding === "binary"
        ? 0
        : this.currentOutput === "coverage"
          ? 1
          : 2;
  }
}
