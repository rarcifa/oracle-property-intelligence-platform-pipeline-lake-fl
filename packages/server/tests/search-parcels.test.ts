/**
 * The parcel half of `/api/search`, against the real published table.
 *
 * Retrieval covered the dataset's metadata only, so a question about the
 * 215,806 parcels had nothing to retrieve from. BM25 over a per-parcel text
 * profile was built and measured first and was worse than nothing: "aged roof
 * with an open roofing permit in Clermont" returned a Clermont parcel with zero
 * open roofing permits, because a bag of words scores a constraint as a few soft
 * terms. These tests exist to pin the property that failure lacked — every row
 * returned actually satisfies every constraint in the question.
 *
 * Skips when no published Parquet is reachable, like the other query-layer
 * suites; CI sets ORACLE_PARQUET_URL so it cannot skip there.
 */

import { describe, expect, it } from "vitest";
import { hasParquet, getContext } from "./harness.js";
import { Router, type HttpResponse } from "../src/http/router.js";
import { registerSearchRoutes } from "../src/routes/search.js";

interface ParcelHalf {
  interpretation: { filter: string; value: unknown; phrase: string }[];
  filters: Record<string, unknown>;
  matched: number;
  returned: number;
  rows: Record<string, unknown>[];
}

async function search(query: string, topK = 10): Promise<{ parcels: ParcelHalf | null }> {
  const router = new Router();
  registerSearchRoutes(router, await getContext());
  const response = (await router.handle({
    method: "POST",
    path: "/api/search",
    query: new URLSearchParams(),
    headers: {},
    body: { query, topK },
  })) as HttpResponse;
  expect(response.status).toBe(200);
  // The router serialises; the body is JSON text, as in the sibling suite.
  const text =
    typeof response.body === "string" ? response.body : Buffer.from(response.body).toString("utf8");
  return JSON.parse(text) as { parcels: ParcelHalf | null };
}

describe.skipIf(!hasParquet)("POST /api/search — retrieval over the parcels", () => {
  it("returns rows that satisfy every constraint in the question", async () => {
    const { parcels } = await search("aged roofs with an open roofing permit in Clermont");
    expect(parcels).not.toBeNull();
    const half = parcels as ParcelHalf;
    // 11 parcels county-wide carry an aged roof and an open roofing permit; 2
    // are in Clermont. Verified independently against /api/sql.
    expect(half.matched).toBe(2);
    expect(half.rows.length).toBe(2);
    for (const row of half.rows) {
      expect(Number(row.roof_age_years)).toBeGreaterThanOrEqual(15);
      expect(Number(row.open_roofing_permit_count)).toBeGreaterThan(0);
      expect(String(row.address_city)).toBe("CLERMONT");
    }
  }, 120_000);

  it("answers an unsatisfiable question with nothing, rather than the nearest parcel", async () => {
    // None of those 2 Clermont parcels is owned out of state. BM25 over a
    // per-parcel text profile answered this exact question with a confident,
    // wrong parcel; the honest answer is zero rows, and the constraints are
    // still shown so a reader can see why.
    const { parcels } = await search(
      "aged roofs with an open roofing permit in Clermont owned out of state",
    );
    const half = parcels as ParcelHalf;
    expect(half.matched).toBe(0);
    expect(half.rows).toHaveLength(0);
    expect(half.filters).toMatchObject({
      minRoofAge: 15,
      hasOpenRoofingPermit: true,
      city: "CLERMONT",
      ownerOutOfState: true,
    });
  }, 120_000);

  it("honours an explicit roof-age threshold rather than the default", async () => {
    const { parcels } = await search("roofs 30 years or older in Leesburg");
    const half = parcels as ParcelHalf;
    expect(half.filters).toMatchObject({ minRoofAge: 30, city: "LEESBURG" });
    for (const row of half.rows) {
      expect(Number(row.roof_age_years)).toBeGreaterThanOrEqual(30);
      expect(String(row.address_city)).toBe("LEESBURG");
    }
  }, 120_000);

  it("finds the long-stalled permits the coverage snapshot counts", async () => {
    const { parcels } = await search("roofing permits still open more than five years");
    const half = parcels as ParcelHalf;
    expect(half.filters).toMatchObject({ minOpenPermitDays: 1825 });
    for (const row of half.rows) {
      expect(Number(row.longest_open_permit_days)).toBeGreaterThan(1825);
    }
  }, 120_000);

  it("reports the true total, not the page size", async () => {
    const { parcels } = await search("out of state owners", 5);
    const half = parcels as ParcelHalf;
    expect(half.returned).toBeLessThanOrEqual(5);
    // The published coverage snapshot records 20,236 out-of-state owners.
    expect(half.matched).toBe(20236);
  }, 120_000);

  it("explains itself, naming the phrase behind every filter", async () => {
    const { parcels } = await search("aged roofs in Clermont");
    const half = parcels as ParcelHalf;
    expect(half.interpretation.map((entry) => entry.filter).sort()).toEqual(["city", "minRoofAge"]);
    for (const entry of half.interpretation) expect(entry.phrase.length).toBeGreaterThan(0);
  }, 120_000);

  it("returns no parcel half for a question about the data rather than the parcels", async () => {
    const { parcels } = await search("why is contractor_name empty");
    expect(parcels).toBeNull();
  }, 120_000);
});
