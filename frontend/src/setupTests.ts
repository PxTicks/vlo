import "@testing-library/jest-dom";
import "fake-indexeddb/auto";

// Polyfill crypto.randomUUID
if (!globalThis.crypto) {
  Object.defineProperty(globalThis, "crypto", {
    value: {},
    writable: true,
  });
}

if (!globalThis.crypto.randomUUID) {
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    value: () => `test-uuid-${Math.random().toString(36).substring(7)}`,
    writable: true,
  });
}