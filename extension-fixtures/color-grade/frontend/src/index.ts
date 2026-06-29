import type { ExtensionModule } from "@vlo/extension-sdk";

const FILTER_VERTEX = `
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

const FILM_GRADE_FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform float uExposure;
uniform float uContrast;
uniform float uSaturation;

void main(void) {
  vec4 source = texture(uTexture, vTextureCoord);
  vec3 color = source.a > 0.0 ? source.rgb / source.a : source.rgb;
  color *= exp2(uExposure);
  color = (color - 0.5) * uContrast + 0.5;
  float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = mix(vec3(luma), color, uSaturation);
  finalColor = vec4(color * source.a, source.a);
}
`;

export const activate: ExtensionModule["activate"] = (context) => {
  const grade = context.api.transformations.register({
    id: "film-grade",
    apiVersion: 1,
    kind: "trusted-filter",
    label: "Custom GLSL Film Grade",
    adjustmentCompatible: true,
    groups: [
      {
        id: "film-grade",
        title: "Film Grade",
        controls: [
          {
            type: "slider",
            name: "exposure",
            label: "Exposure",
            defaultValue: 0,
            min: -5,
            max: 5,
            step: 0.1,
            supportsSpline: true,
          },
          {
            type: "slider",
            name: "contrast",
            label: "Contrast",
            defaultValue: 1,
            min: 0,
            max: 4,
            step: 0.05,
            supportsSpline: true,
          },
          {
            type: "slider",
            name: "saturation",
            label: "Saturation",
            defaultValue: 1,
            min: 0,
            max: 4,
            step: 0.05,
            supportsSpline: true,
          },
        ],
      },
    ],
    createFilter: () => {
      const uniforms = {
        uExposure: { value: 0, type: "f32" },
        uContrast: { value: 1, type: "f32" },
        uSaturation: { value: 1, type: "f32" },
      };
      const filter = context.api.runtime.pixi.Filter.from({
        gl: {
          name: "example-color-grade",
          vertex: FILTER_VERTEX,
          fragment: FILM_GRADE_FRAGMENT,
        },
        resources: { gradeUniforms: uniforms },
      });
      return {
        object: filter,
        update: (parameters) => {
          uniforms.uExposure.value = Number(parameters.exposure);
          uniforms.uContrast.value = Number(parameters.contrast);
          uniforms.uSaturation.value = Number(parameters.saturation);
        },
      };
    },
  });

  context.api.ui.registerComponent({
    id: "film-grade-controls",
    apiVersion: 1,
    slot: "transformation-panel.before",
    kind: "trusted-react",
    component: () =>
      context.api.runtime.react.createElement(
        "p",
        { "data-extension": "example.color-grade" },
        `Custom shader ready: ${grade.id}`,
      ),
  });

  context.logger.info("Custom GLSL color-grade fixture activated.", {
    contributionId: grade.id,
  });
};
