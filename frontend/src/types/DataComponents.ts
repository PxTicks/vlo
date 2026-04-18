/**
 * DataComponent: a general, data-only attachment on a clip.
 *
 * Mirrors ClipComponent (which references subordinate clips) but carries
 * pure data instead. Every concrete kind extends DataComponentBase with a
 * string literal `type` discriminator and a typed `parameters` payload, so
 * consumers can narrow the union safely.
 */
export interface DataComponentBase<TType extends string, TParams> {
  id: string;
  type: TType;
  parameters: TParams;
}

export interface RangeMaskDataComponentParameters {
  startSourceTicks: number;
  endSourceTicks: number;
  isActive: boolean;
  name?: string;
}

export type RangeMaskDataComponent = DataComponentBase<
  "range_mask",
  RangeMaskDataComponentParameters
>;

export type DataComponent = RangeMaskDataComponent;

export type DataComponentType = DataComponent["type"];

export function isDataComponentOfType<T extends DataComponentType>(
  component: DataComponent,
  type: T,
): component is Extract<DataComponent, { type: T }> {
  return component.type === type;
}
