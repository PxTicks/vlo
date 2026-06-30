import type {
  ExtensionGenerationApi,
  ExtensionModule,
  ExtensionReactRuntime,
  ExtensionUiModalComponentProps,
  JsonValue,
} from "@vlo/extension-sdk";

interface ReactHooksRuntime extends ExtensionReactRuntime {
  useState<T>(initial: T): [T, (next: T | ((current: T) => T)) => void];
}

export interface LayoutPromptRegion {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly prompt: string;
  readonly color: string;
}

interface PointerSurfaceEvent {
  readonly clientX: number;
  readonly clientY: number;
  readonly pointerId: number;
  readonly currentTarget: {
    getBoundingClientRect(): DOMRect;
    setPointerCapture?(pointerId: number): void;
  };
  preventDefault(): void;
  stopPropagation(): void;
}

interface ValueEvent {
  readonly target: { readonly value: string };
}

interface DragState {
  readonly regionId: string;
  readonly startX: number;
  readonly startY: number;
}

const DEFAULT_REGION: LayoutPromptRegion = {
  id: "region-1",
  x: 0.1,
  y: 0.12,
  width: 0.35,
  height: 0.3,
  prompt: "Primary subject",
  color: "#7c3aed",
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function validColor(value: string): string {
  return /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : "#7c3aed";
}

export function formatLayoutPrompt(
  regions: readonly LayoutPromptRegion[],
): string {
  return JSON.stringify(
    {
      schemaVersion: 1,
      coordinateSpace: "normalized",
      regions: regions.map((region) => ({
        id: region.id,
        prompt: region.prompt.trim(),
        color: validColor(region.color),
        boundingBox: {
          x: Number(region.x.toFixed(4)),
          y: Number(region.y.toFixed(4)),
          width: Number(region.width.toFixed(4)),
          height: Number(region.height.toFixed(4)),
        },
      })),
    },
    null,
    2,
  );
}

export function commitLayoutPrompt(
  generation: ExtensionGenerationApi,
  inputId: string,
  regions: readonly LayoutPromptRegion[],
) {
  return generation.transaction("Apply visual layout prompt", (transaction) => {
    transaction.setTextInput(inputId, formatLayoutPrompt(regions));
  });
}

function pointFromEvent(event: PointerSurfaceEvent) {
  const bounds = event.currentTarget.getBoundingClientRect();
  return {
    x: clamp01((event.clientX - bounds.left) / Math.max(1, bounds.width)),
    y: clamp01((event.clientY - bounds.top) / Math.max(1, bounds.height)),
  };
}

function createLayoutPromptModal(
  React: ReactHooksRuntime,
  generation: ExtensionGenerationApi,
) {
  return function LayoutPromptModal({ close }: ExtensionUiModalComponentProps) {
    const textInputs = generation
      .listInputs()
      .filter((input) => input.inputType === "text");
    const [targetInputId, setTargetInputId] = React.useState(
      textInputs[0]?.id ?? "",
    );
    const [regions, setRegions] = React.useState<readonly LayoutPromptRegion[]>([
      DEFAULT_REGION,
    ]);
    const [selectedId, setSelectedId] = React.useState(DEFAULT_REGION.id);
    const [drag, setDrag] = React.useState<DragState | null>(null);
    const [status, setStatus] = React.useState(
      textInputs.length > 0
        ? "Draw on the canvas or edit the selected region."
        : "The active workflow has no text input.",
    );
    const selected = regions.find((region) => region.id === selectedId);
    const h = React.createElement;

    const updateSelected = (patch: Partial<LayoutPromptRegion>) => {
      setRegions((current) =>
        current.map((region) =>
          region.id === selectedId ? { ...region, ...patch } : region,
        ),
      );
    };

    const pointerDown = (event: PointerSurfaceEvent) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      const point = pointFromEvent(event);
      const id = `region-${Date.now()}-${regions.length + 1}`;
      setRegions((current) => [
        ...current,
        {
          id,
          x: point.x,
          y: point.y,
          width: 0.01,
          height: 0.01,
          prompt: "New region",
          color: "#06b6d4",
        },
      ]);
      setSelectedId(id);
      setDrag({ regionId: id, startX: point.x, startY: point.y });
    };

    const pointerMove = (event: PointerSurfaceEvent) => {
      if (!drag) return;
      const point = pointFromEvent(event);
      setRegions((current) =>
        current.map((region) =>
          region.id === drag.regionId
            ? {
                ...region,
                x: Math.min(drag.startX, point.x),
                y: Math.min(drag.startY, point.y),
                width: Math.max(0.01, Math.abs(point.x - drag.startX)),
                height: Math.max(0.01, Math.abs(point.y - drag.startY)),
              }
            : region,
        ),
      );
    };

    const apply = () => {
      if (!targetInputId) {
        setStatus("Choose a workflow text input first.");
        return;
      }
      const result = commitLayoutPrompt(generation, targetInputId, regions);
      if (!result.ok) {
        setStatus(result.message);
        return;
      }
      close({
        inputId: targetInputId,
        regionCount: regions.length,
      } satisfies JsonValue);
    };

    return h(
      "div",
      { style: { display: "grid", gap: 12 } },
      h(
        "label",
        null,
        "Workflow text input ",
        h(
          "select",
          {
            value: targetInputId,
            onChange: (event: ValueEvent) => setTargetInputId(event.target.value),
          },
          ...textInputs.map((input) =>
            h("option", { key: input.id, value: input.id }, input.label),
          ),
        ),
      ),
      h(
        "svg",
        {
          viewBox: "0 0 1000 600",
          role: "img",
          "aria-label": "Visual prompt layout canvas",
          onPointerDown: pointerDown,
          onPointerMove: pointerMove,
          onPointerUp: () => setDrag(null),
          style: {
            width: "100%",
            minHeight: 260,
            background: "#111827",
            border: "1px solid #475569",
            cursor: "crosshair",
            touchAction: "none",
          },
        },
        ...regions.flatMap((region) => [
          h("rect", {
            key: `${region.id}-box`,
            x: region.x * 1000,
            y: region.y * 600,
            width: region.width * 1000,
            height: region.height * 600,
            fill: `${validColor(region.color)}33`,
            stroke: validColor(region.color),
            strokeWidth: region.id === selectedId ? 6 : 3,
            onPointerDown: (event: PointerSurfaceEvent) => {
              event.preventDefault();
              event.stopPropagation();
              setSelectedId(region.id);
            },
          }),
          h(
            "text",
            {
              key: `${region.id}-label`,
              x: region.x * 1000 + 10,
              y: region.y * 600 + 24,
              fill: "#ffffff",
              style: { pointerEvents: "none", fontSize: 18 },
            },
            region.prompt || "Untitled region",
          ),
        ]),
      ),
      selected
        ? h(
            "div",
            { style: { display: "grid", gridTemplateColumns: "1fr auto", gap: 8 } },
            h("input", {
              "aria-label": "Region prompt",
              value: selected.prompt,
              onInput: (event: ValueEvent) =>
                updateSelected({ prompt: event.target.value }),
            }),
            h("input", {
              "aria-label": "Region color",
              type: "color",
              value: validColor(selected.color),
              onInput: (event: ValueEvent) =>
                updateSelected({ color: event.target.value }),
            }),
          )
        : null,
      h("pre", { style: { maxHeight: 180, overflow: "auto" } }, formatLayoutPrompt(regions)),
      h("p", { role: "status" }, status),
      h(
        "div",
        { style: { display: "flex", justifyContent: "flex-end", gap: 8 } },
        h("button", { type: "button", onClick: () => close() }, "Cancel"),
        h("button", { type: "button", onClick: apply }, "Apply JSON prompt"),
      ),
    );
  };
}

export const activate: ExtensionModule["activate"] = (context) => {
  const React = context.api.runtime.react as ReactHooksRuntime;
  const Button = context.api.runtime.mui.Button;
  context.api.ui.registerModal({
    id: "layout-prompt",
    apiVersion: 1,
    kind: "trusted-modal",
    title: "Visual layout prompt",
    size: "large",
    component: createLayoutPromptModal(React, context.api.generation),
  });
  context.api.ui.registerComponent({
    id: "open-layout-prompt",
    apiVersion: 1,
    slot: "generation.toolbar",
    kind: "trusted-react",
    order: -100,
    component: () =>
      React.createElement(
        Button,
        {
          type: "button",
          size: "small",
          variant: "outlined",
          onClick: () => void context.api.ui.openModal("layout-prompt"),
        },
        "Layout prompt",
      ),
  });
  context.logger.info("Layout prompt UI conformance fixture activated.");
};
