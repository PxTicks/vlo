import type { Page } from '@playwright/test';

/**
 * Capability probe for the browser-media lane (plan §4.6).
 *
 * The Phase 4 A/V canary and the Phase 5 pixel-parity canary are only
 * meaningful against Chromium's real WebGL, WebCodecs and Web Audio paths. A
 * software-rasterised WebGL backend (ANGLE/SwiftShader) is acceptable — it
 * compiles and executes real GLSL — but a missing or stubbed implementation is
 * not, because a jsdom-shaped fallback would let both canaries pass while
 * proving nothing.
 *
 * The probe therefore *draws* rather than feature-detecting, and checks the
 * specific encode/decode configurations the canaries will actually run rather
 * than the mere presence of the WebCodecs constructors. Its job is early,
 * diagnostic failure; the canaries themselves still perform the real work.
 */

export interface MediaConfigResult {
    kind: 'video-decode' | 'video-encode' | 'audio-decode' | 'audio-encode';
    label: string;
    codec: string;
    supported: boolean;
    error: string | null;
}

export interface MediaCapabilityReport {
    webgl: {
        ok: boolean;
        version: string | null;
        renderer: string | null;
        vendor: string | null;
        /** Pixel read back after drawing through a compiled fragment shader. */
        drawnPixel: [number, number, number, number] | null;
        error: string | null;
    };
    webCodecs: {
        ok: boolean;
        interfaces: {
            VideoDecoder: boolean;
            VideoEncoder: boolean;
            AudioDecoder: boolean;
            AudioEncoder: boolean;
        };
        /** Required configurations — any unsupported entry fails the lane. */
        configs: MediaConfigResult[];
        error: string | null;
    };
    webAudio: {
        ok: boolean;
        sampleRate: number | null;
        /** Proves the audio clock genuinely advances, not just that it exists. */
        clockAdvanced: boolean;
        /** Required by TrackAudioRenderer / CompositeAudioTrackRenderer. */
        offlineAudioContext: boolean;
        error: string | null;
    };
}

interface MediaConfigSpec {
    kind: MediaConfigResult['kind'];
    label: string;
    config: Record<string, unknown>;
}

/**
 * Derived from the fixtures and the encoder, not guessed:
 *
 * - `TextureOutputEncoder.ts:187,217` picks `vp9`/`opus` for WebM output and
 *   `avc`/`aac` for MP4.
 * - `project_current`'s baked composite reports `V_VP9` + `A_OPUS` in its EBML
 *   header; its `.m4a` carries `mp4a`/`esds` (AAC); its sources are `avc1`.
 *
 * VP8 is deliberately absent — no fixture uses it, and requiring it would gate
 * the lane on a codec no canary touches.
 */
const REQUIRED_CONFIGS: MediaConfigSpec[] = [
    {
        kind: 'video-decode',
        label: 'H.264 source video (project_current .mp4 assets)',
        config: { codec: 'avc1.42E01E', codedWidth: 640, codedHeight: 360 },
    },
    {
        kind: 'video-decode',
        label: 'VP9 baked composite (Phase 5 decoded-bake capture)',
        config: { codec: 'vp09.00.10.08', codedWidth: 640, codedHeight: 360 },
    },
    {
        kind: 'video-encode',
        label: 'VP9 bake output (Phase 5.3 bake round trip)',
        config: {
            codec: 'vp09.00.10.08',
            width: 640,
            height: 360,
            bitrate: 6_000_000,
        },
    },
    {
        kind: 'audio-decode',
        label: 'AAC source audio (Phase 4 .m4a A/V canary)',
        config: { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 },
    },
    {
        kind: 'audio-decode',
        label: 'Opus baked-composite audio (Phase 4 composite-with-audio)',
        config: { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 },
    },
    {
        kind: 'audio-encode',
        label: 'Opus bake output (Phase 5.3 bake round trip)',
        config: {
            codec: 'opus',
            sampleRate: 48000,
            numberOfChannels: 2,
            bitrate: 128_000,
        },
    },
    {
        // `TextureOutputEncoder.ts:190` requests `alpha: "keep"` for every WebM
        // bake, but that string never reaches WebCodecs. mediabunny forces
        // `alpha: "discard"` and implements alpha itself with two parallel
        // encoders, pinning `latencyMode: "quality"` so neither drops frames
        // (`media-source.js:367-373`). This is the configuration a Phase 5.3
        // alpha bake genuinely issues — probing `alpha: "keep"` instead reports
        // a failure for a request the app never makes.
        kind: 'video-encode',
        label: 'VP9 alpha bake (mediabunny dual-encoder path)',
        config: {
            codec: 'vp09.00.10.08',
            width: 640,
            height: 360,
            bitrate: 6_000_000,
            alpha: 'discard',
            latencyMode: 'quality',
        },
    },
];

export async function probeMediaCapabilities(
    page: Page,
): Promise<MediaCapabilityReport> {
    return page.evaluate(
        async ({ required }: { required: MediaConfigSpec[] }) => {
            const report = {
                webgl: {
                    ok: false,
                    version: null as string | null,
                    renderer: null as string | null,
                    vendor: null as string | null,
                    drawnPixel: null as
                        | [number, number, number, number]
                        | null,
                    error: null as string | null,
                },
                webCodecs: {
                    ok: false,
                    interfaces: {
                        VideoDecoder: false,
                        VideoEncoder: false,
                        AudioDecoder: false,
                        AudioEncoder: false,
                    },
                    configs: [] as MediaConfigResult[],
                    error: null as string | null,
                },
                webAudio: {
                    ok: false,
                    sampleRate: null as number | null,
                    clockAdvanced: false,
                    offlineAudioContext: false,
                    error: null as string | null,
                },
            };

            // --- WebGL: compile, draw, read back -------------------------
            try {
                const canvas = document.createElement('canvas');
                canvas.width = 4;
                canvas.height = 4;
                const gl = canvas.getContext('webgl2');
                if (!gl) throw new Error('webgl2 context unavailable');

                report.webgl.version = gl.getParameter(gl.VERSION) as string;
                report.webgl.vendor = gl.getParameter(gl.VENDOR) as string;
                const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
                report.webgl.renderer = (
                    debugInfo
                        ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
                        : gl.getParameter(gl.RENDERER)
                ) as string;

                const compile = (type: number, source: string) => {
                    const shader = gl.createShader(type);
                    if (!shader) throw new Error('createShader returned null');
                    gl.shaderSource(shader, source);
                    gl.compileShader(shader);
                    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                        throw new Error(
                            `shader compile failed: ${gl.getShaderInfoLog(shader)}`,
                        );
                    }
                    return shader;
                };

                const program = gl.createProgram();
                if (!program) throw new Error('createProgram returned null');
                gl.attachShader(
                    program,
                    compile(
                        gl.VERTEX_SHADER,
                        `#version 300 es
                         in vec2 position;
                         void main() { gl_Position = vec4(position, 0.0, 1.0); }`,
                    ),
                );
                gl.attachShader(
                    program,
                    compile(
                        gl.FRAGMENT_SHADER,
                        `#version 300 es
                         precision highp float;
                         out vec4 fragColor;
                         void main() { fragColor = vec4(1.0, 0.0, 0.0, 1.0); }`,
                    ),
                );
                gl.linkProgram(program);
                if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
                    throw new Error(
                        `link failed: ${gl.getProgramInfoLog(program)}`,
                    );
                }
                gl.useProgram(program);

                const buffer = gl.createBuffer();
                gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
                gl.bufferData(
                    gl.ARRAY_BUFFER,
                    new Float32Array([-1, -1, 3, -1, -1, 3]),
                    gl.STATIC_DRAW,
                );
                const location = gl.getAttribLocation(program, 'position');
                gl.enableVertexAttribArray(location);
                gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);

                gl.viewport(0, 0, 4, 4);
                gl.clearColor(0, 0, 0, 1);
                gl.clear(gl.COLOR_BUFFER_BIT);
                gl.drawArrays(gl.TRIANGLES, 0, 3);

                const pixel = new Uint8Array(4);
                gl.readPixels(2, 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
                report.webgl.drawnPixel = [
                    pixel[0],
                    pixel[1],
                    pixel[2],
                    pixel[3],
                ];
                report.webgl.ok =
                    pixel[0] === 255 &&
                    pixel[1] === 0 &&
                    pixel[2] === 0 &&
                    pixel[3] === 255;
                if (!report.webgl.ok) {
                    report.webgl.error = `expected an opaque red pixel, read [${report.webgl.drawnPixel.join(', ')}]`;
                }
            } catch (error) {
                report.webgl.error =
                    error instanceof Error ? error.message : String(error);
            }

            // --- WebCodecs: probe the real configurations -----------------
            try {
                const codecInterfaces = {
                    VideoDecoder:
                        typeof globalThis.VideoDecoder !== 'undefined',
                    VideoEncoder:
                        typeof globalThis.VideoEncoder !== 'undefined',
                    AudioDecoder:
                        typeof globalThis.AudioDecoder !== 'undefined',
                    AudioEncoder:
                        typeof globalThis.AudioEncoder !== 'undefined',
                };
                report.webCodecs.interfaces = codecInterfaces;

                const codecApi: Record<
                    MediaConfigResult['kind'],
                    {
                        available: boolean;
                        check?: (
                            config: Record<string, unknown>,
                        ) => Promise<{ supported?: boolean }>;
                    }
                > = {
                    'video-decode': {
                        available: codecInterfaces.VideoDecoder,
                        check: (config) =>
                            globalThis.VideoDecoder.isConfigSupported(
                                config as VideoDecoderConfig,
                            ),
                    },
                    'video-encode': {
                        available: codecInterfaces.VideoEncoder,
                        check: (config) =>
                            globalThis.VideoEncoder.isConfigSupported(
                                config as VideoEncoderConfig,
                            ),
                    },
                    'audio-decode': {
                        available: codecInterfaces.AudioDecoder,
                        check: (config) =>
                            globalThis.AudioDecoder.isConfigSupported(
                                config as AudioDecoderConfig,
                            ),
                    },
                    'audio-encode': {
                        available: codecInterfaces.AudioEncoder,
                        check: (config) =>
                            globalThis.AudioEncoder.isConfigSupported(
                                config as AudioEncoderConfig,
                            ),
                    },
                };

                const evaluate = async (
                    specs: MediaConfigSpec[],
                ): Promise<MediaConfigResult[]> => {
                    const results: MediaConfigResult[] = [];
                    for (const spec of specs) {
                        const api = codecApi[spec.kind];
                        const codec = String(spec.config.codec);
                        if (!api.available || !api.check) {
                            results.push({
                                kind: spec.kind,
                                label: spec.label,
                                codec,
                                supported: false,
                                error: `${spec.kind} interface unavailable`,
                            });
                            continue;
                        }
                        try {
                            const support = await api.check(spec.config);
                            results.push({
                                kind: spec.kind,
                                label: spec.label,
                                codec,
                                supported: support.supported === true,
                                error: null,
                            });
                        } catch (error) {
                            results.push({
                                kind: spec.kind,
                                label: spec.label,
                                codec,
                                supported: false,
                                error:
                                    error instanceof Error
                                        ? error.message
                                        : String(error),
                            });
                        }
                    }
                    return results;
                };

                report.webCodecs.configs = await evaluate(required);
                report.webCodecs.ok =
                    Object.values(codecInterfaces).every(Boolean) &&
                    report.webCodecs.configs.every(
                        (result) => result.supported,
                    );
            } catch (error) {
                report.webCodecs.error =
                    error instanceof Error ? error.message : String(error);
            }

            // --- Web Audio: prove the clock actually runs -----------------
            let audioContext: AudioContext | null = null;
            try {
                report.webAudio.offlineAudioContext =
                    typeof OfflineAudioContext !== 'undefined';

                audioContext = new AudioContext();
                report.webAudio.sampleRate = audioContext.sampleRate;
                await audioContext.resume();
                const started = audioContext.currentTime;
                await new Promise((resolve) => setTimeout(resolve, 120));
                report.webAudio.clockAdvanced =
                    audioContext.currentTime > started;
                report.webAudio.ok =
                    audioContext.state === 'running' &&
                    audioContext.sampleRate > 0 &&
                    report.webAudio.clockAdvanced &&
                    report.webAudio.offlineAudioContext;
                if (!report.webAudio.ok && !report.webAudio.clockAdvanced) {
                    report.webAudio.error = `audio clock did not advance (state: ${audioContext.state})`;
                }
            } catch (error) {
                report.webAudio.error =
                    error instanceof Error ? error.message : String(error);
            } finally {
                await audioContext?.close().catch(() => {});
            }

            return report;
        },
        { required: REQUIRED_CONFIGS },
    );
}

/**
 * Throws with a full report when any required capability is missing.
 *
 * Deliberately throws rather than skipping: §4.6 requires the lane to fail
 * loudly, because a skipped media canary is indistinguishable from a passing
 * one in a nightly summary.
 */
export function assertMediaCapabilities(report: MediaCapabilityReport): void {
    const failures: string[] = [];
    if (!report.webgl.ok) {
        failures.push(
            `WebGL2: ${report.webgl.error ?? 'unavailable'} (renderer: ${report.webgl.renderer ?? 'unknown'})`,
        );
    }

    const missingInterfaces = Object.entries(report.webCodecs.interfaces)
        .filter(([, present]) => !present)
        .map(([name]) => name);
    if (missingInterfaces.length > 0) {
        failures.push(
            `WebCodecs interfaces missing: ${missingInterfaces.join(', ')}`,
        );
    }
    for (const result of report.webCodecs.configs) {
        if (result.supported) continue;
        failures.push(
            `WebCodecs ${result.kind} unsupported — ${result.label} [${result.codec}]${
                result.error ? `: ${result.error}` : ''
            }`,
        );
    }
    if (report.webCodecs.error) {
        failures.push(`WebCodecs probe error: ${report.webCodecs.error}`);
    }

    if (!report.webAudio.ok) {
        failures.push(
            `Web Audio: ${report.webAudio.error ?? 'unavailable'}${
                report.webAudio.offlineAudioContext
                    ? ''
                    : ' (OfflineAudioContext missing)'
            }`,
        );
    }

    if (failures.length > 0) {
        throw new Error(
            [
                'Browser-media lane capability check failed. These specs assert real',
                'decoder/WebGL behaviour and must not run against a degraded browser.',
                '',
                ...failures.map((failure) => `  - ${failure}`),
                '',
                'Run this lane via `npm run test:e2e:media` (see plan §4.6).',
            ].join('\n'),
        );
    }
}

/** Human-readable backend summary, attached to reports for triage. */
export function describeMediaBackend(report: MediaCapabilityReport): string {
    const line = (result: MediaConfigResult) =>
        `  [${result.supported ? 'ok' : 'MISSING'}] ${result.kind} ${result.codec} — ${result.label}`;

    return [
        `webgl.renderer: ${report.webgl.renderer ?? 'unknown'}`,
        `webgl.version: ${report.webgl.version ?? 'unknown'}`,
        `audio.sampleRate: ${report.webAudio.sampleRate ?? 'unknown'}`,
        `audio.offlineAudioContext: ${report.webAudio.offlineAudioContext}`,
        'required media configurations:',
        ...report.webCodecs.configs.map(line),
    ].join('\n');
}
