import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  describeFileSystemAccessIssue,
  getFileSystemAccessIssue,
  isNonChromiumBrowser,
} from "../utils/browser";

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

describe("getFileSystemAccessIssue", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const FIREFOX_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/117.0";
  const SAFARI_UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Safari/605.1.15";

  // Defaults to a secure Chromium page; `window.chrome` is what marks one.
  function stubBrowser(
    windowProps: Record<string, unknown>,
    navigatorProps: Record<string, unknown> = {},
  ) {
    vi.stubGlobal("window", {
      isSecureContext: true,
      chrome: {},
      ...windowProps,
    });
    vi.stubGlobal("navigator", { userAgent: "", ...navigatorProps });
  }

  it("reports nothing when the folder picker exists", () => {
    stubBrowser({ showDirectoryPicker: vi.fn() });
    expect(getFileSystemAccessIssue()).toBeNull();
  });

  it("blames an insecure origin before the browser", () => {
    // Even Chrome hides the picker from a plain-http network address.
    stubBrowser({ isSecureContext: false }, { brave: {} });
    expect(getFileSystemAccessIssue()).toBe("insecure-context");
  });

  it("points Brave at the flag that ships disabled", () => {
    stubBrowser({}, { brave: { isBrave: vi.fn() } });
    expect(getFileSystemAccessIssue()).toBe("brave-flag");
    expect(describeFileSystemAccessIssue("brave-flag")).toContain(
      "brave://flags/#file-system-access-api",
    );
  });

  it("reports a Chromium build that lacks the API", () => {
    stubBrowser({});
    expect(getFileSystemAccessIssue()).toBe("unsupported");
  });

  it.each([
    ["Firefox", FIREFOX_UA],
    ["Safari", SAFARI_UA],
  ])(
    "does not send insecure %s to HTTPS, where it still has no picker",
    (_name, userAgent) => {
      stubBrowser(
        { isSecureContext: false, chrome: undefined },
        { userAgent },
      );
      expect(getFileSystemAccessIssue()).toBe("unsupported");
    },
  );

  it("returns null in a non-browser environment", () => {
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("navigator", undefined);
    expect(getFileSystemAccessIssue()).toBeNull();
  });
});
