# Transformations Feature

This module handles the transformation pipeline for clips, including layout, time, audio, masks, and visual effects.

## Overview

The system is designed to be data-driven and extensible. It separates:

- **Transient logic** that must be recalculated every frame.
- **Persistent render objects** that should be reused instead of recreated.
- **UI schema** that describes controls without hard-coding form layouts into each component.

At a high level:

1. **Defaults** create a fresh `TransformState` for the current clip and target.
2. **Handlers** apply transformation logic into that state.
3. **Applicators** sync the computed state back onto Pixi targets and long-lived filter instances.

## Core Architecture

### Registry-Driven Catalogue

`catalogue/TransformationRegistry.ts` is the central registry for the feature. It:

- aggregates every transformation definition;
- marks which definitions are default vs addable;
- exposes helpers for lookup, UI grouping, labeling, and compatibility filtering.

Each transformation definition is self-contained and typically provides:

- a `type`;
- a `label`;
- a `handler`;
- optional applicator metadata such as `FilterClass`;
- a `uiConfig` schema for rendering controls.

### Atomic and Composite Transformations

Transformation logic stays small and composable.

- Atomic handlers live in focused files such as `catalogue/layout/position.ts`, `catalogue/layout/scale.ts`, and `catalogue/layout/rotation.ts`.
- Composite definitions stitch those handlers together when the UI should treat several transform types as one logical section.

The main example is `catalogue/layout/layoutDefinition.ts`, which:

- defines base layout defaults with `getBaseLayout`;
- applies layout values to the target with `layoutApplicator`;
- dispatches `position`, `scale`, and `rotation` transforms through one composite `layout` definition.

This lets the registry treat layout as one default feature while still keeping the underlying math isolated and testable.

### Dynamic UI Generation

The UI is generated from each definition's `uiConfig.groups`.

- `ControlDefinition` describes a single control and its metadata.
- `LayoutGroup` describes a titled section and grid layout.
- `catalogue/ui/UITypes.ts` re-exports these shared schema types.

On the component side:

- `components/TransformationPanel.tsx` is the main orchestrator.
- `components/DefaultTransformationSections.tsx` renders default sections such as layout or volume.
- `components/SortableTransformationItem.tsx` renders addable transforms that can be reordered.
- `components/TransformationGroup.tsx` and `components/ControlRenderer.tsx` render the schema into actual controls.

Because the panel reads directly from the registry, new transformations usually become available in both the add menu and the editor UI as soon as their definition is registered.

## Directory Structure

```text
catalogue/
├── TransformationRegistry.ts   # Central registry and helper lookups
├── types.ts                    # TransformationDefinition, TransformState, etc.
├── filterHandler.ts            # Generic handler for filter-type transforms
├── filterFactory.ts            # Filter applicator and filter lifecycle management
├── layout/
│   ├── layoutDefinition.ts     # Composite layout definition and base layout defaults
│   ├── position.ts             # Position handler
│   ├── scale.ts                # Scale handler
│   ├── rotation.ts             # Rotation handler
│   └── templates/              # Fit templates such as contain
├── time/
│   └── speed.ts                # Speed/time-warp definition
├── audio/
│   └── volume.ts               # Volume definition
├── mask/
│   ├── grow.ts                 # Mask grow definition
│   └── feather.ts              # Mask feather definition
├── filters/                    # Pixi filter definitions
└── ui/
    └── UITypes.ts              # Re-exported UI schema types
```

## How It Works

### Frame Evaluation

1. A fresh state is created from base defaults.
2. Matching handlers mutate that state based on active transform data.
3. Applicators push the resolved state onto the current render target.

This keeps per-frame math pure while avoiding churn in Pixi objects.

### Filter Chain

Standard filters use the generic filter pipeline:

1. `filterHandler` reads timeline data and pushes filter operations into `state.filters`.
2. `filterApplicator` walks those operations in order.
3. The applicator looks up the registered definition, reuses any existing filter instances, and updates their parameters.

Filters are cumulative and ordered. If multiple filters are active, they are applied in the order they appear in `state.filters`.

## How to Add a New Transformation

### Add a New Filter

For standard Pixi filters, use the generic filter factory pattern. You do not need a custom handler or applicator.

1. Create a definition in `catalogue/filters/`:

```typescript
import { BlurFilter } from "pixi.js";
import type { TransformationDefinition } from "../types";
import { filterHandler } from "../filterHandler";

export const blurFilterDefinition: TransformationDefinition = {
  type: "filter",
  filterName: "BlurFilter",
  FilterClass: BlurFilter,
  label: "Blur",
  handler: filterHandler,
  uiConfig: {
    groups: [
      {
        id: "blur",
        title: "Blur",
        columns: 1,
        controls: [
          {
            type: "slider",
            label: "Strength",
            name: "strength",
            defaultValue: 0,
            min: 0,
            max: 20,
          },
          {
            type: "number",
            label: "Quality",
            name: "quality",
            defaultValue: 4,
            min: 1,
            max: 10,
          },
        ],
      },
    ],
  },
};
```

2. Register it in `catalogue/TransformationRegistry.ts`.

Once registered, the system will automatically:

- show it in the add menu when compatible;
- generate controls from `uiConfig`;
- instantiate and update the Pixi filter through the generic applicator.

### Add a New Non-Filter Transformation

For a new logical transform type such as opacity:

1. Create the handler and definition in the appropriate catalogue area.
2. Add the `uiConfig.groups` schema describing its controls.
3. Register the definition in `TransformationRegistry.ts`.

If the transform should behave like a default section, register it with `isDefault: true` in the registry. If it should be user-addable, register it as non-default.

## UI Integration Notes

- Definitions can expose multiple groups, which allows one logical transform to render several control sections.
- Composite definitions can also map `handledTypes` to individual groups, which is how layout exposes separate Position, Scale, and Rotation sections while remaining one registry entry.
- Compatibility checks in the registry ensure only valid transforms are shown for the active clip type and target.
