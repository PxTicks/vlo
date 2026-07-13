import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import {
  ExtensionPanelControlRegistry,
  HOST_PANEL_CONTROL_TARGETS,
  extensionPanelControlRegistry,
} from "../ExtensionPanelControlRegistry";
import { ExtensionPanelControlZone } from "../ExtensionPanelControlZone";
import { getCustomControl } from "../../../panelUI";
import type {
  ExtensionApiScope,
  ExtensionPanelControlProps,
  JsonValue,
} from "../../types";

const GRADE_TARGET = HOST_PANEL_CONTROL_TARGETS[0];

function createScope(id = "example.grading"): {
  scope: ExtensionApiScope;
  owned: { dispose(): void | Promise<void> }[];
  report: ReturnType<typeof vi.fn>;
} {
  const owned: { dispose(): void | Promise<void> }[] = [];
  const report = vi.fn();
  const scope = {
    extension: { id, version: "1.0.0" },
    signal: new AbortController().signal,
    own: <T,>(resource: T): T => {
      owned.push(resource as { dispose(): void });
      return resource;
    },
    report,
  } as unknown as ExtensionApiScope;
  return { scope, owned, report };
}

function disposeAll(owned: { dispose(): void | Promise<void> }[]): void {
  for (const resource of [...owned].reverse()) void resource.dispose();
}

describe("ExtensionPanelControlRegistry", () => {
  afterEach(cleanup);

  it("owner-qualifies the ID and projects the control into the host lookup", () => {
    const registry = new ExtensionPanelControlRegistry();
    const { scope, owned } = createScope();

    const registration = registry
      .bind(scope)
      .registerPanelControl({
        id: "auto-balance",
        apiVersion: 1,
        kind: "trusted-react",
        component: () => null,
      });

    expect(registration.id).toBe("example.grading/auto-balance");
    expect(getCustomControl("example.grading/auto-balance")).toBeTypeOf("function");

    disposeAll(owned);
    expect(getCustomControl("example.grading/auto-balance")).toBeUndefined();
  });

  it("rejects an undeclared host panel zone", () => {
    const registry = new ExtensionPanelControlRegistry();
    const { scope } = createScope();

    expect(() =>
      registry.bind(scope).registerPanelControl({
        id: "rogue",
        apiVersion: 1,
        kind: "trusted-react",
        component: () => null,
        placements: [
          {
            target: { kind: "filter", filterName: "BlurFilter", zone: "extensions" },
          },
        ],
      }),
    ).toThrow(/undeclared host panel zone/i);
  });

  it("rejects a bad apiVersion, kind, component, and non-JSON config", () => {
    const registry = new ExtensionPanelControlRegistry();
    const bind = registry.bind(createScope().scope);
    const base = {
      id: "control",
      apiVersion: 1,
      kind: "trusted-react",
      component: () => null,
    } as const;

    expect(() =>
      bind.registerPanelControl({ ...base, apiVersion: 2 } as never),
    ).toThrow(/trusted-react API 1/i);
    expect(() =>
      bind.registerPanelControl({ ...base, component: undefined } as never),
    ).toThrow(/component function/i);
    expect(() =>
      bind.registerPanelControl({
        ...base,
        placements: [{ target: GRADE_TARGET, config: { bad: () => 1 } }],
      } as never),
    ).toThrow(/finite JSON object/i);
  });

  it("lists zone contributions ordered by order, then qualified ID", () => {
    const registry = new ExtensionPanelControlRegistry();
    const first = createScope("aaa.ext");
    const second = createScope("zzz.ext");
    const third = createScope("mmm.ext");

    for (const { scope } of [first, second, third]) {
      registry.bind(scope).registerPanelControl({
        id: "control",
        apiVersion: 1,
        kind: "trusted-react",
        component: () => null,
        placements: [
          {
            target: GRADE_TARGET,
            order: scope.extension.id === "zzz.ext" ? -1 : 0,
          },
        ],
      });
    }

    expect(registry.list(GRADE_TARGET).map((entry) => entry.contribution.id)).toEqual([
      "zzz.ext/control",
      "aaa.ext/control",
      "mmm.ext/control",
    ]);
  });

  it("deep-freezes detached placement config", () => {
    const registry = new ExtensionPanelControlRegistry();
    const { scope, owned } = createScope();

    registry.bind(scope).registerPanelControl({
      id: "configured",
      apiVersion: 1,
      kind: "trusted-react",
      component: () => null,
      placements: [
        {
          target: GRADE_TARGET,
          config: {
            nested: { strength: 0.5 },
            stops: [{ position: 0 }],
          },
        },
      ],
    });

    const config = registry.list(GRADE_TARGET)[0].placement.config;
    const nested = config.nested as Readonly<Record<string, JsonValue>>;
    const stops = config.stops as readonly JsonValue[];

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(nested)).toBe(true);
    expect(Object.isFrozen(stops)).toBe(true);
    expect(Object.isFrozen(stops[0])).toBe(true);

    disposeAll(owned);
  });
});

describe("ExtensionPanelControlZone", () => {
  let owned: { dispose(): void | Promise<void> }[] = [];

  beforeEach(() => {
    owned = [];
  });
  afterEach(() => {
    cleanup();
    disposeAll(owned);
  });

  function zoneProps(onCommitMany = vi.fn()) {
    return {
      control: {
        type: "custom" as const,
        name: "_extensions",
        label: "Extensions",
        config: { filterName: "ColorGradeFilter", zone: "extensions" },
        parameterNames: ["exposure"],
      },
      value: undefined,
      values: { exposure: 1, saturation: 2 },
      onCommit: vi.fn(),
      onCommitMany,
      groupId: "color_grade_extensions",
      transformId: "t1",
      disabled: false,
    };
  }

  it("renders nothing when no extension has placed a control", () => {
    const { container } = render(
      createElement(ExtensionPanelControlZone, zoneProps()),
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("mounts a placed contribution and empties when it is disposed", async () => {
    const scope = createScope("looks.pack");
    owned = scope.owned;

    // The zone observes the module singleton, which is what the grade panel uses.
    extensionPanelControlRegistry.bind(scope.scope).registerPanelControl({
      id: "auto-balance",
      apiVersion: 1,
      kind: "trusted-react",
      component: (props: ExtensionPanelControlProps) =>
        createElement(
          "button",
          {
            type: "button",
            onClick: () => props.commitParameter("exposure", 0.25),
          },
          "Auto balance",
        ),
      placements: [{ target: GRADE_TARGET }],
    });

    const onCommitMany = vi.fn();
    const { container, rerender } = render(
      createElement(ExtensionPanelControlZone, zoneProps(onCommitMany)),
    );

    const button = await screen.findByRole("button", { name: "Auto balance" });
    await userEvent.click(button);
    expect(onCommitMany).toHaveBeenCalledWith({ exposure: 0.25 });

    disposeAll(scope.owned);
    owned = [];
    rerender(createElement(ExtensionPanelControlZone, zoneProps(onCommitMany)));
    expect(container).toBeEmptyDOMElement();
  });
});

describe("panel control props boundary", () => {
  afterEach(cleanup);

  it("commits through the host path, and rejects parameters outside the allowlist", async () => {
    const registry = new ExtensionPanelControlRegistry();
    const { scope, report } = createScope();
    let captured: ExtensionPanelControlProps | null = null;

    registry.bind(scope).registerPanelControl({
      id: "editor",
      apiVersion: 1,
      kind: "trusted-react",
      component: (props: ExtensionPanelControlProps) => {
        captured = props;
        return createElement(
          "button",
          {
            type: "button",
            onClick: () => props.commitParameter("exposure", 1.5),
          },
          "commit",
        );
      },
    });

    const Control = getCustomControl("example.grading/editor")!;
    const onCommitMany = vi.fn();
    render(
      createElement(Control, {
        control: {
          type: "custom",
          name: "_editor",
          label: "Editor",
          componentId: "example.grading/editor",
          parameterNames: ["exposure"],
        },
        value: undefined,
        values: { exposure: 0.5, saturation: 1 },
        onCommit: vi.fn(),
        onCommitMany,
        groupId: "grade",
        transformId: "t1",
        disabled: false,
      }),
    );

    await userEvent.click(screen.getByRole("button", { name: "commit" }));
    expect(onCommitMany).toHaveBeenCalledWith({ exposure: 1.5 });

    const props = captured as unknown as ExtensionPanelControlProps;
    expect(props.values).toEqual({ exposure: 0.5, saturation: 1 });

    // Outside the allowlist: reported, and never reaches the host commit path.
    onCommitMany.mockClear();
    props.commitParameter("saturation", 2 as JsonValue);
    expect(onCommitMany).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith(
      "error",
      expect.stringMatching(/may not commit parameter 'saturation'/),
    );
  });

  it("detaches values so an extension cannot mutate host state", () => {
    const registry = new ExtensionPanelControlRegistry();
    const { scope } = createScope();
    let captured: ExtensionPanelControlProps | null = null;

    registry.bind(scope).registerPanelControl({
      id: "reader",
      apiVersion: 1,
      kind: "trusted-react",
      component: (props: ExtensionPanelControlProps) => {
        captured = props;
        return null;
      },
    });

    const hostValues = { curveMaster: [{ x: 0, y: 0 }] };
    const Control = getCustomControl("example.grading/reader")!;
    render(
      createElement(Control, {
        control: {
          type: "custom",
          name: "_reader",
          label: "Reader",
          componentId: "example.grading/reader",
          parameterNames: [],
        },
        value: undefined,
        values: hostValues,
        onCommit: vi.fn(),
        onCommitMany: vi.fn(),
        groupId: "grade",
        disabled: false,
      }),
    );

    const props = captured as unknown as ExtensionPanelControlProps;
    expect(props.values.curveMaster).toEqual([{ x: 0, y: 0 }]);
    expect(props.values.curveMaster).not.toBe(hostValues.curveMaster);
  });
});
