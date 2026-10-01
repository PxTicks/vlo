import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { isNonChromiumBrowser } from "../utils/browser";

describe("isNonChromiumBrowser", () => {
  const originalNavigator = globalThis.navigator;
  const originalWindow = globalThis.window;

  beforeEach(() => {
    vi.stubGlobal("navigator", { ...originalNavigator, userAgent: "", userAgentData: undefined });
    vi.stubGlobal("window", { ...originalWindow, chrome: undefined });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns false in a non-browser environment", () => {
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("navigator", undefined);
    expect(isNonChromiumBrowser()).toBe(false);
  });

  it("returns false for modern Chromium browsers via userAgentData", () => {
    vi.stubGlobal("navigator", {
      ...originalNavigator,
      userAgentData: {
        brands: [{ brand: "NotAChromiumBrand", version: "1" }, { brand: "Chromium", version: "116" }]
      }
    });
    vi.stubGlobal("window", { ...originalWindow, chrome: {} });
    expect(isNonChromiumBrowser()).toBe(false);
  });

  it("returns false for Chrome browser without userAgentData but with window.chrome", () => {
    // Missing userAgentData, but has window.chrome and normal user agent
    vi.stubGlobal("navigator", {
      ...originalNavigator,
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36",
    });
    vi.stubGlobal("window", { ...originalWindow, chrome: {} });
    expect(isNonChromiumBrowser()).toBe(false);
  });

  it("returns true for Firefox", () => {
    vi.stubGlobal("navigator", {
      ...originalNavigator,
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/117.0",
    });
    // Firefox does not have window.chrome
    expect(isNonChromiumBrowser()).toBe(true);
  });

  it("returns true for Safari", () => {
    vi.stubGlobal("navigator", {
      ...originalNavigator,
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Safari/605.1.15",
    });
    // Safari does not have window.chrome
    expect(isNonChromiumBrowser()).toBe(true);
  });
});
