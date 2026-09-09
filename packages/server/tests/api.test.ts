/** Route-level tests: status codes, validation, and response shape. */
import { afterAll, describe, expect, it } from "vitest";
import type { Router } from "../src/http/router.js";
import { bodyJson, closeStore, getRouter, hasParquet, request } from "./harness.js";

interface ErrorBody {
  error: string;
  detail?: string;
}

describe.skipIf(!hasParquet)("REST API", () => {
  let router: Router | null = null;

  const getRouterOnce = async (): Promise<Router> => {
    router ??= await getRouter();
    return router;
  };

  afterAll(() => {
    closeStore();
  });

  it("reports health with a real property count", async () => {
    const response = await request(await getRouterOnce(), "GET", "/api/health");
    expect(response.status).toBe(200);
    const body = bodyJson<{ ok: boolean; propertyCount: number; dataSourceKind: string }>(response);
    expect(body.ok).toBe(true);
    expect(body.propertyCount).toBeGreaterThan(100_000);
    expect(["ipfs", "local"]).toContain(body.dataSourceKind);
  });

  it("serves the 59-column schema", async () => {
    const response = await request(await getRouterOnce(), "GET", "/api/meta/schema");
    const body = bodyJson<{ columnCount: number; alwaysNullColumns: Record<string, string> }>(
      response,
    );
    expect(body.columnCount).toBe(59);
    expect(body.alwaysNullColumns.contractor_name).toContain("403");
  });

  it("serves the run pointer, coverage snapshot and gateway posture", async () => {
    const response = await request(await getRouterOnce(), "GET", "/api/meta/run");
    const body = bodyJson<{
      coverage: { limitations: string[] } | null;
      gateways: { id: string; range: boolean }[];
      unusableGateways: { host: string }[];
      chatEnabled: boolean;
    }>(response);
    expect(response.status).toBe(200);
    expect(body.coverage?.limitations.length ?? 0).toBeGreaterThan(0);
    // More than one gateway must be able to serve a range read, or the runtime
    // is back to depending on a single vendor.
    expect(body.gateways.filter((gateway) => gateway.range).length).toBeGreaterThan(1);
    // Re-measured 2026-09-10 against the published Parquet: dweb.link answers
    // 301 on this path. ipfs.io, which used to be listed here, answers 206 with
    // CORS and is now a usable range gateway.
    expect(body.unusableGateways.map((entry) => entry.host)).toContain("dweb.link");
    expect(body.unusableGateways.map((entry) => entry.host)).not.toContain("ipfs.io");
    expect(body.chatEnabled).toBe(false);
  });

  it("serves the cross-gateway verification evidence for the published run", async () => {
    const response = await request(await getRouterOnce(), "GET", "/api/meta/run");
    const body = bodyJson<{
      run: { runId: string; rootCid: string } | null;
      verification: {
        runId: string;
        rootCid: string;
        verifications: {
          name: string;
          cid: string;
          verified: boolean;
          matchedGateways: string[];
        }[];
      } | null;
      runHistory: { runs: unknown[] } | null;
    }>(response);
    if (body.run === null) return; // Nothing published yet: nothing to verify.
    expect(body.verification?.runId).toBe(body.run.runId);
    expect(body.verification?.rootCid).toBe(body.run.rootCid);
    const verifications = body.verification?.verifications ?? [];
    expect(verifications.length).toBeGreaterThan(0);
    for (const entry of verifications) {
      expect(entry.matchedGateways.length).toBeGreaterThan(0);
    }
    expect((body.runHistory?.runs ?? []).length).toBeGreaterThan(0);
  });

  it("searches with filters and reports a true matching total", async () => {
    const response = await request(
      await getRouterOnce(),
      "GET",
      "/api/properties?minRoofAge=15&limit=5",
    );
    const body = bodyJson<{ rows: unknown[]; matched: number; provenance: { sql: string } }>(
      response,
    );
    expect(body.rows).toHaveLength(5);
    expect(body.matched).toBeGreaterThan(5);
    expect(body.provenance.sql).toContain("roof_age_years >= 15");
  });

  it("rejects an unknown sort column with a 400", async () => {
    const response = await request(
      await getRouterOnce(),
      "GET",
      "/api/properties?sortBy=not_a_column",
    );
    expect(response.status).toBe(400);
    expect(bodyJson<ErrorBody>(response).error).toBe("invalid_query");
  });

  it("rejects a partial radius specification with a 400", async () => {
    const response = await request(
      await getRouterOnce(),
      "GET",
      "/api/properties?lat=28.5&radiusMiles=2",
    );
    expect(response.status).toBe(400);
    expect(bodyJson<ErrorBody>(response).detail).toMatch(/lat, lon and radiusMiles/);
  });

  it("404s an unknown parcel with a readable message", async () => {
    const response = await request(
      await getRouterOnce(),
      "GET",
      "/api/properties/00-00-00-0000-000-00000",
    );
    expect(response.status).toBe(404);
    expect(bodyJson<ErrorBody>(response).error).toBe("Property not found");
  });

  it("returns a property detail with gating notices", async () => {
    const list = await request(await getRouterOnce(), "GET", "/api/properties?limit=1");
    const parcelId = String(
      bodyJson<{ rows: { request_identifier: string }[] }>(list).rows[0]?.request_identifier,
    );
    const response = await request(
      await getRouterOnce(),
      "GET",
      `/api/properties/${encodeURIComponent(parcelId)}`,
    );
    expect(response.status).toBe(200);
    const body = bodyJson<{ gating: { field: string }[] }>(response);
    expect(body.gating.map((notice) => notice.field)).toEqual(["contractor_name", "bbb_rating"]);
  });

  it("serves the three named views", async () => {
    for (const path of ["/api/views/tenant", "/api/views/business", "/api/views/contractor"]) {
      const response = await request(await getRouterOnce(), "GET", path);
      expect(response.status, path).toBe(200);
    }
  });

  it("runs a read-only statement through /api/sql", async () => {
    const response = await request(await getRouterOnce(), "POST", "/api/sql", {
      sql: "SELECT count(*) AS n FROM properties WHERE roof_age_years >= 15",
    });
    expect(response.status).toBe(200);
    const body = bodyJson<{ rows: { n: number }[] }>(response);
    expect(body.rows[0]?.n).toBeGreaterThan(0);
  });

  it("rejects a mutating statement through /api/sql", async () => {
    const response = await request(await getRouterOnce(), "POST", "/api/sql", {
      sql: "DELETE FROM properties",
    });
    expect(response.status).toBe(400);
    expect(bodyJson<ErrorBody>(response).error).toBe("sql_rejected");
  });

  it("rejects a second statement smuggled after a semicolon", async () => {
    const response = await request(await getRouterOnce(), "POST", "/api/sql", {
      sql: "SELECT 1; DROP TABLE properties",
    });
    expect(response.status).toBe(400);
    expect(bodyJson<ErrorBody>(response).detail).toMatch(/single statement/);
  });

  it("returns 503 from /api/chat when no model key is configured", async () => {
    const response = await request(await getRouterOnce(), "POST", "/api/chat", {
      messages: [{ role: "user", content: "how many parcels?" }],
    });
    expect(response.status).toBe(503);
    const body = bodyJson<ErrorBody>(response);
    expect(body.error).toBe("chat_unavailable");
    expect(body.detail).toContain("ANTHROPIC_API_KEY");
  });

  it("405s a GET on a POST-only route", async () => {
    const response = await request(await getRouterOnce(), "GET", "/api/sql");
    expect(response.status).toBe(405);
  });
});
