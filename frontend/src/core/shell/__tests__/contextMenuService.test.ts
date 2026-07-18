import { describe, expect, it, vi } from "vitest";
import { ContextMenuService } from "../contextMenuService";
import { HostMenuCatalog } from "../hostMenuCatalog";

function createService() {
  const catalog = new HostMenuCatalog();
  catalog.declare({
    id: "timeline.clip.context",
    validateSubject: (subject) =>
      typeof subject === "object" && subject !== null && "clip" in subject,
  });
  return { service: new ContextMenuService(catalog), catalog };
}

const REQUEST = {
  menuId: "timeline.clip.context",
  subject: { slot: "timeline.clip.context", clip: { id: "c1" } },
  items: [],
  position: { x: 10, y: 20 },
} as const;

describe("ContextMenuService", () => {
  it("shows a validated request, replaces the active menu, and closes by handle", () => {
    const { service } = createService();
    const listener = vi.fn();
    service.subscribe(listener);

    const first = service.show(REQUEST);
    expect(service.getActive()).toMatchObject({
      menuId: "timeline.clip.context",
      position: { x: 10, y: 20 },
    });
    expect(listener).toHaveBeenCalledTimes(1);

    const second = service.show({ ...REQUEST, position: { x: 1, y: 2 } });
    expect(service.getActive()?.position).toEqual({ x: 1, y: 2 });

    // A stale handle must not close a newer menu.
    first.dispose();
    expect(service.getActive()).not.toBeNull();
    second.dispose();
    expect(service.getActive()).toBeNull();
  });

  it("throws on undeclared menus and invalid subjects", () => {
    const { service } = createService();
    expect(() =>
      service.show({ ...REQUEST, menuId: "missing.menu" }),
    ).toThrow(/not in the host menu catalogue/);
    expect(() =>
      service.show({ ...REQUEST, subject: { wrong: true } }),
    ).toThrow(/failed its schema/);
    expect(service.getActive()).toBeNull();
  });

  it("close() without an ID always clears; with an ID only the matching menu", () => {
    const { service } = createService();
    service.show(REQUEST);
    service.close(999);
    expect(service.getActive()).not.toBeNull();
    service.close();
    expect(service.getActive()).toBeNull();
  });
});
