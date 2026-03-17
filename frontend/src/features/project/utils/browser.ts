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
