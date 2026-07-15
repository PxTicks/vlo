import { defineConfig } from "vitest/config";

// Pure-logic unit tests for the fixture's deterministic Matrix math and
// parameter validation. No DOM or Pixi runtime is needed: the CPU reference
// mirrors the shader algorithm and the validation path is plain data.
export default defineConfig({
  test: {
    environment: "node",
    include: ["frontend/src/**/__tests__/**/*.test.ts"],
  },
});
