import type {
  ExtensionModule,
  JsonValue,
} from "@vlo/extension-sdk";

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

interface FixtureGraphics {
  clear(): FixtureGraphics;
  rect(x: number, y: number, width: number, height: number): FixtureGraphics;
  roundRect(
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
  ): FixtureGraphics;
  fill(color: string): FixtureGraphics;
}

interface ShapePayload {
  width: number;
  height: number;
  radius: number;
  color: string;
}

function shapePayload(data: JsonValue): ShapePayload {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("Shape payload must be an object.");
  }
  const { width, height, radius, color } = data;
  if (
    typeof width !== "number" ||
    !Number.isFinite(width) ||
    width <= 0 ||
    typeof height !== "number" ||
    !Number.isFinite(height) ||
    height <= 0 ||
    typeof radius !== "number" ||
    !Number.isFinite(radius) ||
    radius < 0 ||
    typeof color !== "string" ||
    !/^#[0-9a-f]{6}$/i.test(color)
  ) {
    throw new Error("Shape payload has invalid geometry or color.");
  }
  return { width, height, radius, color };
}

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

  const Graphics = context.api.runtime.pixi.Graphics as {
    new (): FixtureGraphics;
  };
  const shape = context.api.entityProviders.register({
    id: "rounded-rectangle",
    apiVersion: 1,
    kind: "trusted-pixi",
    label: "Rounded rectangle",
    timelineColor: "#7c3aed",
    schemaVersion: 1,
    defaultPayload: {
      width: 640,
      height: 360,
      radius: 48,
      color: "#8b5cf6",
    },
    validate: (data) => {
      shapePayload(data);
    },
    getRenderSignature: ({ data }) => JSON.stringify(data),
    createRenderable: () => {
      const graphics = new Graphics();
      return {
        object: graphics as object,
        update: ({ data }) => {
          const value = shapePayload(data);
          graphics
            .clear()
            .roundRect(
              -value.width / 2,
              -value.height / 2,
              value.width,
              value.height,
              value.radius,
            )
            .fill(value.color);
        },
      };
    },
    inspector: (props) => {
      const value = shapePayload(props.data);
      return context.api.runtime.react.createElement(
        "button",
        {
          type: "button",
          onClick: () =>
            props.updateData({
              ...value,
              color: value.color === "#8b5cf6" ? "#06b6d4" : "#8b5cf6",
            }),
        },
        `Toggle shape color (${value.color})`,
      );
    },
  });
  const progress = context.api.entityProviders.register({
    id: "animated-progress",
    apiVersion: 1,
    kind: "trusted-pixi",
    label: "Animated progress",
    timelineColor: "#0891b2",
    schemaVersion: 1,
    defaultPayload: {
      width: 720,
      height: 64,
      background: "#164e63",
      fill: "#22d3ee",
    },
    validate: (data) => {
      if (typeof data !== "object" || data === null || Array.isArray(data)) {
        throw new Error("Progress payload must be an object.");
      }
      if (
        typeof data.width !== "number" ||
        data.width <= 0 ||
        typeof data.height !== "number" ||
        data.height <= 0 ||
        typeof data.background !== "string" ||
        typeof data.fill !== "string"
      ) {
        throw new Error("Progress payload is invalid.");
      }
    },
    createRenderable: () => {
      const graphics = new Graphics();
      return {
        object: graphics as object,
        update: ({ data }, { entity, frame }) => {
          if (typeof data !== "object" || data === null || Array.isArray(data)) {
            throw new Error("Progress payload must be an object.");
          }
          const width = Number(data.width);
          const height = Number(data.height);
          const fraction = Math.max(
            0,
            Math.min(1, frame.visualTimeTicks / entity.durationTicks),
          );
          graphics
            .clear()
            .rect(-width / 2, -height / 2, width, height)
            .fill(String(data.background))
            .rect(-width / 2, -height / 2, width * fraction, height)
            .fill(String(data.fill));
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
        "div",
        { "data-extension": "example.color-grade" },
        context.api.runtime.react.createElement(
          "p",
          null,
          `Custom shader ready: ${grade.id}`,
        ),
        context.api.runtime.react.createElement(
          "button",
          {
            type: "button",
            onClick: () =>
              context.api.timeline.transaction(
                "Add rounded rectangle",
                (transaction) => {
                  transaction.createEntity({
                    name: "Rounded rectangle",
                    startTicks: 0,
                    durationTicks: context.api.timeline.ticksPerSecond * 5,
                    payload: {
                      extensionId: context.extension.id,
                      typeId: "rounded-rectangle",
                      schemaVersion: 1,
                      data: {
                        width: 640,
                        height: 360,
                        radius: 48,
                        color: "#8b5cf6",
                      },
                    },
                  });
                },
              ),
          },
          `Add ${shape.id}`,
        ),
      ),
  });

  context.logger.info("Custom GLSL color-grade fixture activated.", {
    contributionId: grade.id,
    entityProviderId: shape.id,
    animatedEntityProviderId: progress.id,
  });
};
