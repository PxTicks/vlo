/**
 * Phase 0 baseline program: a single-pass passthrough/debug shader.
 *
 * It reuses the standard Pixi v8 filter vertex header and, in the fragment
 * stage, tints the source toward the configured background/matrix green by
 * `uDebugTint`. This proves the trusted-filter path — custom GLSL constructed
 * from the injected host Pixi singleton, rendered through the normal live and
 * export applicator stack — without yet standing up the glyph grid, feedback
 * textures, or WGSL program that later phases add.
 *
 * Premultiplied alpha is preserved so the passthrough composites correctly on
 * transparent input, matching the host applicator's expectations.
 */

export const MATRIX_RAIN_VERTEX = `
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

export const MATRIX_RAIN_FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform float uDebugTint;
uniform vec3 uBackgroundColor;

void main(void) {
  vec4 source = texture(uTexture, vTextureCoord);
  vec3 rgb = source.a > 0.0 ? source.rgb / source.a : source.rgb;
  float luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  // Debug baseline: fade the source toward a luma-modulated matrix green so the
  // effect is visibly active while remaining a faithful single-pass passthrough
  // at uDebugTint = 0.
  vec3 matrix = uBackgroundColor + vec3(0.0, luma, 0.0);
  vec3 result = mix(rgb, matrix, uDebugTint);
  finalColor = vec4(result * source.a, source.a);
}
`;
