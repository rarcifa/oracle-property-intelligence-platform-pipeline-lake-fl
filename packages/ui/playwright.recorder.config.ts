/** Isolated recorder behavior checks. All page requests are fulfilled locally. */
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./test/browser",
  testMatch: /record-preview-(paint|historical)\.browser\.spec\.ts$/,
  outputDir: "./test-results/recorder-paint",
  fullyParallel: true,
  timeout: 15000,
  expect: { timeout: 5000 },
  reporter: "list",
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
