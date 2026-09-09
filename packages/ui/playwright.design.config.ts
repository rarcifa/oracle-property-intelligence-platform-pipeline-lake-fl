/**
 * Playwright configuration for the mocked responsive-design lane.
 *
 * These specs are the deterministic half of the design coverage: every API
 * response is a fixture captured from the real server, every off-origin request
 * is blocked, and the app is pinned to the server data path, so a failure is a
 * layout failure and nothing else.
 *
 * The web server builds the SPA before serving it, so the specs always run
 * against the bundle that would ship rather than a stale `dist/`; the server is
 * never reused for the same reason.
 *
 * Requires the Playwright browser once per machine: `pnpm exec playwright
 * install chromium`.
 */

import { defineConfig, devices } from "@playwright/test";

const HOST = "127.0.0.1";
const PORT = Number(process.env.DESIGN_PORT ?? 4319);
const baseURL = `http://${HOST}:${PORT}`;

export default defineConfig({
  testDir: "./test/design",
  testMatch: /.*\.design\.spec\.ts$/,
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [["list"]],
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    colorScheme: "dark",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm run build && pnpm exec vite preview --host ${HOST} --port ${PORT} --strictPort`,
    url: baseURL,
    cwd: import.meta.dirname,
    // Never reuse: a preview server someone left running would serve a stale
    // bundle and quietly pass these specs against last week's CSS.
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
