import type { MenuTreeCustomization } from "./menuTree";

interface PersistedMenuLayoutResponse {
  readonly revision: number;
  readonly customization: MenuTreeCustomization | null;
}

export interface MenuTreeCustomizationSnapshot {
  readonly revision: number;
  readonly customization: MenuTreeCustomization | null;
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

export async function fetchMenuTreeCustomization(
  menuId: string,
  signal?: AbortSignal,
): Promise<MenuTreeCustomizationSnapshot> {
  const response = await fetch(endpoint(menuId), { signal });
  if (!response.ok) await throwResponseError("Menu layout load", response);
  return (await response.json()) as PersistedMenuLayoutResponse;
}

export async function saveMenuTreeCustomization(
  menuId: string,
  customization: MenuTreeCustomization,
  baseRevision: number,
): Promise<MenuTreeCustomizationSnapshot> {
  const response = await fetch(endpoint(menuId), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseRevision, customization }),
  });
  if (!response.ok) await throwResponseError("Menu layout save", response);
  return (await response.json()) as PersistedMenuLayoutResponse;
}

export async function resetMenuTreeCustomization(
  menuId: string,
): Promise<MenuTreeCustomizationSnapshot> {
  const response = await fetch(endpoint(menuId), { method: "DELETE" });
  if (!response.ok) await throwResponseError("Menu layout reset", response);
  return (await response.json()) as PersistedMenuLayoutResponse;
}
