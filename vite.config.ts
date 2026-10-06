import { defineConfig } from "vitest/config";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    target: "es2022",
    lib: {
      entry: "src/module.ts",
      formats: ["es"],
      fileName: () => "sargas-encounter-builder.js",
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/quench/**", "src/types/**"],
      reporter: ["text", "html", "lcov"],
      // Floors set below the current numbers (~40% lines, ~36% branches) to catch large regressions.
      thresholds: { lines: 30, statements: 30, branches: 25, functions: 25 },
    },
  },
});
