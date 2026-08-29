import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Default 5000ms is tight for the browser-agent-core.ts driver tests --
    // launching a real headless Chromium plus several page round-trips
    // comfortably fits locally but ran into the default ceiling on a
    // GitHub-hosted CI runner (confirmed live, 2026-08-29). 20s still bounds
    // a genuinely hung test well under this repo's action-level timeouts
    // (e.g. the browser agent's own default actionTimeoutMs is 15s).
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts"],
      exclude: ["src/lib/**/*.test.ts", "src/lib/drivers/types.ts"],
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 80,
      },
    },
  },
});
