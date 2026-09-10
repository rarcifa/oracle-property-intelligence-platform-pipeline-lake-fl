/** Unit tests for the request router, with no data layer involved. */
import { describe, expect, it } from "vitest";
import { fail, json, Router } from "../src/http/router.js";

function req(method: string, path: string) {
  const url = new URL(path, "http://test.local");
  return {
    method,
    path: url.pathname,
    query: url.searchParams,
    headers: {},
    body: undefined as unknown,
  };
}

describe("Router", () => {
  it("dispatches an exact path", async () => {
    const router = new Router().get("/api/health", () => json(200, { ok: true }));
    const response = await router.handle(req("GET", "/api/health"));
    expect(response.status).toBe(200);
  });

  it("captures a path parameter and decodes it", async () => {
    const router = new Router().get("/api/properties/:parcelId", (request) =>
      json(200, { parcelId: request.params.parcelId }),
    );
    const response = await router.handle(req("GET", "/api/properties/05-18-25-0004-000-00400"));
    expect(JSON.parse(String(response.body))).toEqual({ parcelId: "05-18-25-0004-000-00400" });
  });

  it("answers 405 when the path matches another method", async () => {
    const router = new Router().post("/mcp", () => json(200, {}));
    const response = await router.handle(req("GET", "/mcp"));
    expect(response.status).toBe(405);
  });

  it("answers 404 with no fallback registered", async () => {
    const router = new Router();
    expect((await router.handle(req("GET", "/nope"))).status).toBe(404);
  });

  it("uses the fallback handler when nothing matched", async () => {
    const router = new Router().fallback(() => json(200, { spa: true }));
    const response = await router.handle(req("GET", "/anything/at/all"));
    expect(JSON.parse(String(response.body))).toEqual({ spa: true });
  });

  it("does not confuse paths of different lengths", async () => {
    const router = new Router()
      .get("/api/properties", () => json(200, { list: true }))
      .get("/api/properties/:parcelId", () => json(200, { detail: true }));
    expect(JSON.parse(String((await router.handle(req("GET", "/api/properties"))).body))).toEqual({
      list: true,
    });
    expect(
      JSON.parse(String((await router.handle(req("GET", "/api/properties/x1"))).body)),
    ).toEqual({ detail: true });
  });
});

describe("response helpers", () => {
  it("omits detail when none is given", () => {
    expect(JSON.parse(String(fail(404, "not_found").body))).toEqual({ error: "not_found" });
  });

  it("includes detail when given", () => {
    expect(JSON.parse(String(fail(400, "bad", "why").body))).toEqual({
      error: "bad",
      detail: "why",
    });
  });
});
