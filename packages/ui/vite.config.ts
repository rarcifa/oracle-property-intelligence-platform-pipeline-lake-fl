/**
 * Vite configuration for the Oracle Lake County single-page app.
 *
 * Two things here are load-bearing rather than boilerplate:
 * - `optimizeDeps.exclude` keeps esbuild's pre-bundler away from
 *   `@duckdb/duckdb-wasm`, whose worker/wasm assets must stay as published
 *   files so the browser bootstrap can resolve them from jsDelivr.
 * - `worker.format: "es"` so the DuckDB worker (and any future worker) is
 *   emitted as a module, matching the bundle we instantiate at runtime.
 *
 * The dev proxy points `/api` and `/mcp` at the local server package so the SPA
 * runs same-origin in development exactly as it does in production.
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const SERVER_ORIGIN = "http://localhost:8787";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    sourcemap: true,
    // MapLibre is one large lazy chunk by design; warning at the default 500 kB
    // would flag it on every build without telling us anything new.
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: SERVER_ORIGIN, changeOrigin: true },
      "/mcp": { target: SERVER_ORIGIN, changeOrigin: true },
    },
  },
  optimizeDeps: {
    exclude: ["@duckdb/duckdb-wasm"],
  },
  worker: {
    format: "es",
  },
});
