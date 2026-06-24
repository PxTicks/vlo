import type { StoreApi } from "zustand";

type ZustandStore<State> = Pick<StoreApi<State>, "getInitialState" | "setState">;

export function resetZustandStore<State>(store: ZustandStore<State>): void {
  store.setState(store.getInitialState(), true);
}
