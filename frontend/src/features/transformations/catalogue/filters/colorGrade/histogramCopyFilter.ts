import { Filter, GlProgram } from "pixi.js";

const HISTOGRAM_COPY_VERTEX = `
in vec2 aPosition;
out vec2 vTextureCoord;

uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

void main(void) {
  gl_Position = vec4(
    aPosition.x * 2.0 - 1.0,
    aPosition.y * 2.0 * uOutputTexture.z - uOutputTexture.z,
    0.0,
    1.0
  );
  vTextureCoord = aPosition * (uOutputFrame.zw * uInputSize.zw);
}
`;

const HISTOGRAM_COPY_FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;

void main(void) {
  finalColor = texture(uTexture, vTextureCoord);
}
`;

const HISTOGRAM_COPY_PROGRAM = GlProgram.from({
  vertex: HISTOGRAM_COPY_VERTEX,
  fragment: HISTOGRAM_COPY_FRAGMENT,
  name: "color-grade-histogram-copy",
});

export class HistogramCopyFilter extends Filter {
  constructor() {
    super({ glProgram: HISTOGRAM_COPY_PROGRAM });
  }

  public override destroy(): void {
    super.destroy(false);
  }
}
