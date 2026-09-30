export function isNonChromiumBrowser(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return false; // Default to false in non-browser environments to avoid SSR/test warnings
  }

  // Use the modern navigator.userAgentData if available
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userAgentData = (navigator as any).userAgentData;
  if (userAgentData && Array.isArray(userAgentData.brands)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const isChromiumLike = userAgentData.brands.some((b: any) =>
      b.brand.includes("Chromium") ||
      b.brand.includes("Google Chrome") ||
      b.brand.includes("Microsoft Edge") ||
      b.brand.includes("Brave") ||
      b.brand.includes("Opera")
    );
    if (isChromiumLike) {
      return false; // Confirmed Chromium
    }
  }

  // Fallbacks using userAgent string
  const ua = navigator.userAgent || "";
  
  const isFirefox = ua.toLowerCase().includes("firefox");
  // Safari contains "Safari" but NOT "Chrome" or "Chromium"
  const isSafari = ua.includes("Safari") && !ua.includes("Chrome") && !ua.includes("Chromium");

  if (isFirefox || isSafari) {
    return true; // Confirmed Firefox or Safari (non-Chromium)
  }

  // As a final fallback, check the existence of standard Chromium properties like window.chrome
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hasWindowChrome = !!(window as any).chrome;
  if (!hasWindowChrome) {
    return true; // Missing window.chrome usually implies non-Chromium
  }

  return false;
}

/** Why the folder pickers vlo opens projects with are missing, if they are. */
export type FileSystemAccessIssue = "insecure-context" | "brave-flag" | "unsupported";

function isBraveBrowser(): boolean {
  // Brave reports itself as plain Chrome in the user agent; `navigator.brave`
  // is the documented way to tell it apart.
  return "brave" in navigator;
}

export function getFileSystemAccessIssue(): FileSystemAccessIssue | null {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return null;
  }
  if (typeof window.showDirectoryPicker === "function") return null;

  // 1. Firefox and Safari do not implement the pickers at all, so advice
  //    about secure origins or flags would send those users nowhere.
  if (isNonChromiumBrowser()) return "unsupported";
  // 2. Chromium only exposes the pickers to secure origins, so it loses them
  //    when vlo is opened at a plain-http network address.
  if (!window.isSecureContext) return "insecure-context";
  // 3. Brave ships the API but keeps it behind a flag that is off by default.
  if (isBraveBrowser()) return "brave-flag";
  // 4. A Chromium build without the API (older releases, Android).
  return "unsupported";
}

export function describeFileSystemAccessIssue(
  issue: FileSystemAccessIssue,
): string {
  switch (issue) {
    case "insecure-context":
      return "This browser only lets secure pages open folders. Open vlo at http://localhost or over HTTPS, not a network address.";
    case "brave-flag":
      return "Brave blocks folder access by default. Open brave://flags/#file-system-access-api, set it to Enabled, then relaunch Brave.";
    case "unsupported":
      return "This browser cannot open project folders. vlo needs the File System Access API, available in Chromium-based browsers such as Chrome and Edge.";
  }
}
