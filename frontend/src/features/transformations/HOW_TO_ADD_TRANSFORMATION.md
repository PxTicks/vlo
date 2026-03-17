# How to Add a New Transformation

This guide explains how to add a new **Filter** or **Transformation** to the Vlo transformation system.

## 1. Create the Transformation Definition

Create a new file in `frontend/src/features/transformations/catalogue/filters/` (for filters) or `catalogue/[category]/` (for other types).

**Example: `myNewFilter.ts`**

```typescript
import { MyPixiFilter } from "pixi-filters"; // or your custom filter class
import type { TransformationDefinition } from "../types";
import { filterHandler } from "../filterHandler";

export const myNewFilterDefinition: TransformationDefinition = {
  type: "filter",
  compatibleClips: "visual", // "visual" | "audio" | "text"
  filterName: "MyNewFilter", // Specific ID for filters
  FilterClass: MyPixiFilter, // The actual PixiJS Filter class
  label: "My New Effect", // Display name in UI
  handler: filterHandler, // Generic handler for filters
  uiConfig: {
    groups: [
      {
        id: "my_filter_settings",
        title: "Settings",
        columns: 1,
        controls: [
          {
            type: "slider",
            label: "Intensity",
            name: "intensity", // Must match the property on the Filter class
            defaultValue: 1,
            min: 0,
            max: 10,
            step: 0.1,
            supportsSpline: true, // Enable keyframe animation
          },
        ],
      },
    ],
  },
};
```

## 2. Register the Transformation

Open `frontend/src/features/transformations/catalogue/TransformationRegistry.ts`.

1.  **Import** your definition.
2.  **Add** it to the `TransformationRegistry` array.

```typescript
import { myNewFilterDefinition } from "./filters/myNewFilter";

export const TransformationRegistry: TransformationDefinition[] = [
  // ... existing transforms
  { ...myNewFilterDefinition, isDefault: false },
];
```

## 3. Verify

1.  Run the app.
2.  Select a compatible clip.
3.  Click **"Add Transformation"**.
4.  Select your new filter from the list.
5.  Verify the controls appear and affect the render.

## Key Concepts

- **`compatibleClips`**: Controls which clips show this filter (Visual, Audio, etc).
- **`uiConfig`**: Defines the sliders/inputs generated in the right panel.
- **`filterName`**: A unique string ID for the filter type.
- **`FilterClass`**: The actual class instantiated by the PixiJS renderer.

## 4. How to Find Filter Properties

To know what `name` to use in your `controls`, you need to check the properties of the PixiJS filter class.

### Option A: Check the Documentation

1.  Search for the filter (e.g., "pixi-filters AdjustmentFilter").
2.  Look for the **Public Properties**.
    - _Example:_ The docs show `gamma`, `contrast`, `saturation`, etc.
    - These property names become the `name` field in your control config.

### Option B: Check the Type Definition (Surer Method)

If you are using `pixi-filters` or `pixi.js`, you can "Go to Definition" (F12) on the imported class in VS Code.

```typescript
// inside node_modules/pixi-filters/index.d.ts
export class AdjustmentFilter extends Filter {
  constructor(options?: AdjustmentOptions);
  gamma: number; // <--- This is your control name
  saturation: number; // <--- This is your control name
  contrast: number; // <--- This is your control name
  // ...
}
```

### Option C: Console Debugging

If documentation is missing, you can log an instance of the filter to the console to see its properties.

```typescript
import { AdjustmentFilter } from "pixi-filters";
console.log(new AdjustmentFilter());
// Output: AdjustmentFilter { gamma: 1, saturation: 1, ... }
```
