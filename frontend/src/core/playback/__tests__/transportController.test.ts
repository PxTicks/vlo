import { describe, expect, it, vi } from "vitest";
import {
  getHostTransportController,
  installHostTransportController,
  type HostTransportController,
} from "../transportController";

function stubController(): HostTransportController {
  return {
    canControl: () => true,
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
  };
}

describe("host transport controller", () => {
  it("reports no controller until a player installs one", () => {
    const first = stubController();
    const uninstall = installHostTransportController(first);
    expect(getHostTransportController()).toBe(first);
    uninstall();
    expect(getHostTransportController()).toBeNull();
  });

  it("keeps the newest controller when a remount installs before cleanup", () => {
    const first = stubController();
    const second = stubController();
    const uninstallFirst = installHostTransportController(first);
    const uninstallSecond = installHostTransportController(second);

    // React runs the new effect before the old cleanup in some remount paths;
    // the stale cleanup must not empty the registry.
    uninstallFirst();
    expect(getHostTransportController()).toBe(second);

    uninstallSecond();
    expect(getHostTransportController()).toBeNull();
  });
});
