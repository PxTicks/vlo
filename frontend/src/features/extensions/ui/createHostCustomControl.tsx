import type {
  CustomControlComponent,
  CustomControlRenderProps,
} from "../../panelUI";
import { ExtensionPanelControlMount } from "./ExtensionPanelControlHost";
import type {
  ExtensionApiScope,
  ExtensionPanelControlProps,
  JsonValue,
} from "../types";

export interface HostCustomControlSource {
  readonly contributionId: string;
  readonly component: (props: ExtensionPanelControlProps) => unknown;
  readonly report: ExtensionApiScope["report"];
}

/**
 * Projects a panel-control contribution into the host's custom-control registry,
 * so `ControlRenderer` mounts it exactly like a built-in rich control when an
 * extension's own transformation references it by `componentId`.
 *
 * The allowlist and config come from the compiled control definition, which the
 * transformation registry owns — an extension cannot widen them from here.
 */
export function createHostCustomControl(
  source: HostCustomControlSource,
): CustomControlComponent {
  return function ExtensionCustomControl(props: CustomControlRenderProps) {
    return (
      <ExtensionPanelControlMount
        contributionId={source.contributionId}
        component={source.component}
        report={source.report}
        config={(props.control.config ?? {}) as Readonly<Record<string, JsonValue>>}
        allowedParameterNames={props.control.parameterNames}
        values={props.values}
        transformId={props.transformId}
        disabled={props.disabled ?? false}
        sourceTimeRange={props.sourceTimeRange}
        onCommitMany={props.onCommitMany}
      />
    );
  };
}
