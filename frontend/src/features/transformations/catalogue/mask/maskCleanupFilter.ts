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
    vec4 color = texture(uTexture, vTextureCoord);
    // Zero out RGB if the pixel is functionally transparent to prevent
    // dirty RGB bleed during blur operations.
    if (color.a < 0.001) {
        color.rgb = vec3(0.0);
    }
    finalColor = color;
}
`;

/**
 * Creates a filter that sets RGB to 0 when Alpha is near 0.
 * Used internally by the feather applicator to prevent dirty alpha
 * colors from bleeding into the blurred feather.
 * Each rig should have its own instance to avoid shared state conflicts.
 */
export function createMaskCleanupFilter(): Filter {
  return Filter.from({
    gl: {
      vertex: defaultVertex,
      fragment: fragmentSrc,
    },
  });
}
