import {
  createMenuTreeCustomization,
  resolveMenuTreeLayout,
  type MenuTreeCustomization,
  type MenuTreeDefinition,
  type MenuTreeLayout,
} from "./menuTree";

interface PersistedMenuLayoutResponse {
  readonly revision: number;
  readonly customization: MenuTreeCustomization | null;
}

export interface MenuTreePersistenceSnapshot {
  readonly revision: number;
  readonly customization: MenuTreeCustomization | null;
  readonly layout: MenuTreeLayout;
}

export class MenuTreePersistenceError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "MenuTreePersistenceError";
    this.status = status;
  }
}

async function throwResponseError(
  operation: string,
  response: Response,
): Promise<never> {
  let detail = "";
  try {
    const payload = (await response.json()) as {
      readonly error?: { readonly message?: string };
    };
    detail = payload.error?.message ?? "";
  } catch {
    // The status text remains a useful fallback for non-JSON failures.
  }
  throw new MenuTreePersistenceError(
    detail || `${operation} failed (${response.status})`,
    response.status,
  );
}

function endpoint(menuId: string): string {
  return `/app/menu-layouts/${encodeURIComponent(menuId)}`;
}

export async function loadMenuTreeCustomization(
  definition: MenuTreeDefinition,
  availableLeafIds: readonly string[],
  signal?: AbortSignal,
): Promise<MenuTreePersistenceSnapshot> {
  const response = await fetch(endpoint(definition.id), { signal });
  if (!response.ok) await throwResponseError("Menu layout load", response);
  const persisted = (await response.json()) as PersistedMenuLayoutResponse;
  return {
    ...persisted,
    layout: resolveMenuTreeLayout(
      definition,
      persisted.customization,
      availableLeafIds,
    ),
  };
}

export async function saveMenuTreeLayout(
  definition: MenuTreeDefinition,
  availableLeafIds: readonly string[],
  layout: MenuTreeLayout,
  baseRevision: number,
): Promise<MenuTreePersistenceSnapshot> {
  const customization = createMenuTreeCustomization(definition, layout);
  const response = await fetch(endpoint(definition.id), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseRevision, customization }),
  });
  if (!response.ok) await throwResponseError("Menu layout save", response);
  const persisted = (await response.json()) as PersistedMenuLayoutResponse;
  return {
    ...persisted,
    layout: resolveMenuTreeLayout(
      definition,
      persisted.customization,
      availableLeafIds,
    ),
  };
}

export async function resetMenuTreeLayout(
  definition: MenuTreeDefinition,
  availableLeafIds: readonly string[],
): Promise<MenuTreePersistenceSnapshot> {
  const response = await fetch(endpoint(definition.id), { method: "DELETE" });
  if (!response.ok) await throwResponseError("Menu layout reset", response);
  const persisted = (await response.json()) as PersistedMenuLayoutResponse;
  return {
    ...persisted,
    layout: resolveMenuTreeLayout(definition, null, availableLeafIds),
  };
}
