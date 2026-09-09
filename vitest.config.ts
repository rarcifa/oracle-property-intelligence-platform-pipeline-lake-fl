import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["packages/*/src/**/*.test.ts", "packages/*/tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", ".claude/**"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: "forks",
  },
});
