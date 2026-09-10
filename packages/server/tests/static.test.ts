/** The static handler must not serve anything outside the built UI directory. */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createStaticHandler } from "../src/http/static.js";

const root = mkdtempSync(join(tmpdir(), "oracle-ui-"));
mkdirSync(join(root, "assets"), { recursive: true });
writeFileSync(join(root, "index.html"), "<html>spa</html>");
writeFileSync(join(root, "assets", "app.js"), "console.log(1)");

const handler = createStaticHandler(root);

function req(path: string, method = "GET") {
  return {
    method,
    path,
    query: new URLSearchParams(),
    headers: {},
    body: undefined as unknown,
    params: {},
  };
}

describe("static handler", () => {
  it("serves a built asset with an immutable cache header", async () => {
    const response = await handler(req("/assets/app.js"));
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/javascript");
    expect(response.headers["cache-control"]).toContain("immutable");
  });

  it("falls back to index.html for a client route", async () => {
    const response = await handler(req("/property/05-18-25-0004-000-00400"));
    expect(response.status).toBe(200);
    expect(String(response.body)).toContain("spa");
  });

  it("never falls back for an API path", async () => {
    expect((await handler(req("/api/does-not-exist"))).status).toBe(404);
  });

  it("refuses a traversal attempt", async () => {
    const response = await handler(req("/../../../../etc/passwd"));
    // Falls back to the SPA rather than reading outside the root.
    expect(response.status).toBe(200);
    expect(String(response.body)).toContain("spa");
  });

  it("rejects a non-GET method", async () => {
    expect((await handler(req("/", "DELETE"))).status).toBe(405);
  });

  it("explains a missing build rather than 404-ing blankly", async () => {
    const missing = createStaticHandler(join(root, "not-built"));
    const response = await missing(req("/"));
    expect(response.status).toBe(503);
    expect(String(response.body)).toContain("pnpm run build");
  });
});
