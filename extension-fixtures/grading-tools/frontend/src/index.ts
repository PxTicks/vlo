import type {
  ColorGradeResolvedParametersV1,
  ExtensionModule,
  ExtensionPanelControlProps,
} from "@vlo/extension-sdk";

/**
 * Exercises the grading extension surface end to end:
 *
 * 1. a rich control mounted in the host's Color Grade extension zone, which
 *    reads live grade values, evaluates them on the CPU with renderer parity,
 *    and commits a multi-parameter patch through the panel's own commit path;
 * 2. the same registered control reused inside the extension's own
 *    transformation, proving the panel-control path is generic rather than
 *    grading-only. There it sees only that transformation's parameters and may
 *    commit only what its allowlist permits;
 * 3. programmatic LUT ingestion into project storage through the public asset
 *    API before committing the returned project asset ID.
 */

const SAMPLE: readonly [number, number, number] = [0.4, 0.45, 0.5];

function formatRgb(color: readonly [number, number, number]): string {
  return color.map((channel) => channel.toFixed(3)).join(", ");
}

export const activate: ExtensionModule["activate"] = (context) => {
  const { color, runtime, ui } = context.api;
  const h = runtime.react.createElement;

  function GradeInspector(props: ExtensionPanelControlProps) {
    const isGrade = props.config.mode === "grade";

    let resolved: ColorGradeResolvedParametersV1 | null = null;
    if (isGrade) {
      try {
        resolved = color.grade.resolve(
          { ...props.values, colorModel: color.grade.defaults.colorModel },
          { sourceTime: props.sourceTimeRange?.minTime ?? 0 },
        );
      } catch {
        // A malformed or unresolvable grade is an editing state, not a crash.
        resolved = null;
      }
    }

    // The host's own pipeline, so this preview matches what the GPU draws.
    const graded = resolved
      ? color.createReferenceColorGradeEvaluator(resolved).apply(SAMPLE)
      : null;

    if (!isGrade) {
      return h(
        "div",
        { "data-extension": "example.grading-tools" },
        h("p", null, `Parameters: ${Object.keys(props.values).join(", ")}`),
      );
    }

    const neutralize = () => {
      if (!resolved) return;
      // Cancel the residual warm/cool cast this grade leaves on mid-grey.
      const [r, , b] = color
        .createReferenceColorGradeEvaluator(resolved)
        .apply(SAMPLE);
      props.commitParameters({
        temperature: resolved.temperature - (r - b) * 100,
        tint: resolved.tint,
      });
    };

    const attachIdentityLut = async () => {
      try {
        const lut = color.createIdentityCubeLut(17);
        const asset = await context.api.assets.ingest({
          name: "grading-tools-identity.cube",
          type: "lut",
          blob: new Blob([color.serializeCubeLut(lut)], {
            type: "text/plain",
          }),
        });
        props.commitParameters({ lutAssetId: asset.id });
      } catch (error) {
        context.logger.error("Could not attach the fixture LUT.", error);
      }
    };

    return h(
      "div",
      { "data-extension": "example.grading-tools" },
      h(
        "p",
        null,
        graded
          ? `Mid-grey under this grade: ${formatRgb(graded)}`
          : "This grade cannot be resolved at the current frame.",
      ),
      h(
        "button",
        {
          type: "button",
          onClick: neutralize,
          disabled: props.disabled || !resolved,
        },
        "Neutralize mid-grey",
      ),
      h(
        "button",
        {
          type: "button",
          onClick: () => void attachIdentityLut(),
          disabled: props.disabled,
        },
        "Attach project identity LUT",
      ),
    );
  }

  const inspector = ui.registerPanelControl({
    id: "grade-inspector",
    apiVersion: 1,
    kind: "trusted-react",
    component: GradeInspector,
    placements: [
      {
        target: {
          kind: "filter",
          filterName: color.grade.filterName,
          zone: "extensions",
        },
        order: 0,
        config: { mode: "grade" },
      },
    ],
  });

  const nudge = context.api.transformations.register({
    id: "nudge",
    apiVersion: 1,
    kind: "trusted-transformation",
    label: "Nudge",
    groups: [
      {
        id: "nudge",
        title: "Nudge",
        controls: [
          {
            type: "slider",
            name: "offsetX",
            label: "Offset X",
            defaultValue: 0,
            min: -500,
            max: 500,
            step: 1,
            supportsSpline: true,
          },
          {
            type: "custom",
            name: "_inspector",
            label: "Inspector",
            componentId: "grade-inspector",
            config: { mode: "parameters" },
            parameterNames: ["offsetX"],
          },
        ],
      },
    ],
    apply: ({ state, transform }) => {
      const offsetX = transform.parameters.offsetX;
      if (typeof offsetX === "number") state.x += offsetX;
    },
  });

  // A static partial patch: it touches these fields and leaves the rest of the
  // grade authored as it is. It applies, undoes, and reloads like any other
  // preset, and disappears from the catalogue when this extension is disabled.
  const look = context.api.transformations.presets.register({
    id: "bleach-bypass",
    apiVersion: 1,
    label: "Bleach bypass",
    target: { kind: "filter", filterName: color.grade.filterName },
    parameters: {
      contrast: 1.18,
      saturation: 0.62,
      kneeThreshold: 0.9,
      kneeSoftness: 0.2,
      toeAmount: 0.08,
    },
    order: 10,
  });

  context.logger.info("Grading tools fixture activated.", {
    panelControlId: inspector.id,
    transformationId: nudge.id,
    presetId: look.id,
  });
};
