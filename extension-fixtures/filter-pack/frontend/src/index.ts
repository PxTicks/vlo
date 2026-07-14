import type { ExtensionModule } from "@vlo/extension-sdk";

const VERTEX = `
in vec2 aPosition;
out vec2 vTextureCoord;
uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

void main(void) {
  vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
  position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
  position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
  gl_Position = vec4(position, 0.0, 1.0);
  vTextureCoord = aPosition * (uOutputFrame.zw * uInputSize.zw);
}
`;

const FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform float uAmount;

void main(void) {
  vec4 source = texture(uTexture, vTextureCoord);
  vec3 rgb = source.a > 0.0 ? source.rgb / source.a : source.rgb;
  float luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  vec3 result = mix(rgb, vec3(luma), uAmount);
  finalColor = vec4(result * source.a, source.a);
}
`;

export const activate: ExtensionModule["activate"] = (context) => {
  context.api.transformations.register({
    id: "desaturate",
    apiVersion: 1,
    kind: "trusted-filter",
    label: "Pack Desaturate",
    adjustmentCompatible: true,
    groups: [
      {
        id: "desaturate",
        title: "Desaturate",
        controls: [
          {
            type: "slider",
            name: "amount",
            label: "Amount",
            defaultValue: 1,
            min: 0,
            max: 1,
            step: 0.01,
            supportsSpline: true,
          },
        ],
      },
    ],
    createFilter: () => {
      const uniforms = { uAmount: { value: 1, type: "f32" } };
      const object = context.api.runtime.pixi.Filter.from({
        gl: {
          name: "example-filter-pack-desaturate",
          vertex: VERTEX,
          fragment: FRAGMENT,
        },
        resources: { filterPackUniforms: uniforms },
      });
      return {
        object,
        update(parameters) {
          uniforms.uAmount.value = Number(parameters.amount);
        },
      };
    },
  });
};
