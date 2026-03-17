import { Filter } from "pixi.js";

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

const fragmentSrc = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;

void main(void)
{
    float alpha = texture(uTexture, vTextureCoord).a;
    float value = alpha >= 0.2 ? 1.0 : 0.0;
    finalColor = vec4(value, value, value, value);
}
`;

/**
 * Hard-thresholds alpha into a binary white/transparent mask.
 * Using a custom shader avoids ColorMatrix premultiply overflow artifacts.
 */
export function createMaskBinaryThresholdFilter(): Filter {
  return Filter.from({
    gl: {
      vertex: defaultVertex,
      fragment: fragmentSrc,
    },
  });
}
