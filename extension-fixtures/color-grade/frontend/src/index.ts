import type { ExtensionModule } from "@vlo/extension-sdk";

export const activate: ExtensionModule["activate"] = (context) => {
  const grade = context.api.transformations.register({
    id: "film-grade",
    apiVersion: 1,
    kind: "host-filter",
    hostFilter: "color-adjustment",
    label: "Film Grade",
    adjustmentCompatible: true,
    groups: [
      {
        id: "film-grade",
        title: "Film Grade",
        controls: [
          {
            type: "slider",
            name: "gamma",
            label: "Gamma",
            defaultValue: 1,
            min: 0,
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
            max: 5,
            step: 0.1,
            supportsSpline: true,
          },
          {
            type: "slider",
            name: "saturation",
            label: "Saturation",
            defaultValue: 1,
            min: 0,
            max: 5,
            step: 0.1,
            supportsSpline: true,
          },
          {
            type: "slider",
            name: "brightness",
            label: "Brightness",
            defaultValue: 1,
            min: 0,
            max: 5,
            step: 0.1,
            supportsSpline: true,
          },
        ],
      },
    ],
  });

  context.api.ui.registerNotice({
    id: "film-grade-help",
    apiVersion: 1,
    slot: "transformation-panel.before",
    kind: "notice",
    title: "Color Grade Fixture",
    message: `Use ${grade.id} from the Add Transformation menu.`,
    tone: "info",
  });

  context.logger.info("Color-grade fixture activated.", {
    contributionId: grade.id,
  });
};
