/**
 * The parcel half of `/api/search`, against actual historical local bytes.
 *
 * Retrieval covered the dataset's metadata only, so a question about the
 * 215,806 parcels had nothing to retrieve from. BM25 over a per-parcel text
 * profile was built and measured first and was worse than nothing: "aged roof
 * with an open roofing permit in Clermont" returned a Clermont parcel with zero
 * open roofing permits, because a bag of words scores a constraint as a few soft
 * terms. These tests exist to pin the property that failure lacked — every row
 * returned actually satisfies every constraint in the question.
 *
 * The materialized historical fixture is required; it is not a current public
 * source-semantic claim. Current public source-only behavior is tested apart.
 */

import { describe, expect, it, vi } from "vitest";
import type { RetrievalResult } from "@oracle-lake/rag";
import type * as ChatRetrieval from "../src/chat/retrieval.js";
import { hasParquet, getContext } from "./harness.js";
import { ACCEPTED_REGRESSION_ROOT_CID, ACCEPTED_REGRESSION_RUN_ID } from "./fixture-config.js";
import { Router, type HttpResponse } from "../src/http/router.js";
import { registerSearchRoutes } from "../src/routes/search.js";

// This suite isolates the structured half, running actual DuckDB filters over
// the frozen legacy table. Its empty documentation fixture is explicitly
// synthetic; it is not the current public corpus relabeled as historical data.
// Live document/receipt compatibility remains tested in search.test.ts and RAG.
vi.mock("../src/chat/retrieval.js", async (original) => {
  const actual = await original<typeof ChatRetrieval>();
  const { ACCEPTED_REGRESSION_RUN_ID: runId, ACCEPTED_REGRESSION_ROOT_CID: rootCid } =
    await import("./fixture-config.js");
  return {
    ...actual,
    searchCorpus: vi.fn(
      (
        input: { query: string },
        served: { runId: string | null; rootCid: string | null },
      ): RetrievalResult => {
        expect(served).toEqual({ runId, rootCid });
        return {
          query: input.query,
          expandedTerms: [],
          queryGrounding: 0,
          unknownTerms: [],
          confidence: "none",
          abstained: true,
          note: "SYNTHETIC_LEGACY_DOCUMENT_FIXTURE: structured-half regression only; no document evidence.",
          chunks: [],
          consideredCount: 0,
          index: {
            chunkCount: 0,
            runId,
            rootCid,
            releaseState: "local_candidate",
            snapshotDigest: `sha256:${"0".repeat(64)}`,
            embeddingModel: "synthetic-legacy-fixture",
            embeddingDimension: 1,
          },
        };
      },
    ),
  };
});

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
  const result = JSON.parse(text) as {
    parcels: ParcelHalf | null;
    note: string;
    chunks: unknown[];
    index: { runId: string; rootCid: string | null };
  };
  expect(result.note).toContain("SYNTHETIC_LEGACY_DOCUMENT_FIXTURE");
  expect(result.chunks).toEqual([]);
  expect(result.index.runId).toBe(ACCEPTED_REGRESSION_RUN_ID);
  expect(result.index.rootCid).toBe(ACCEPTED_REGRESSION_ROOT_CID);
  return result;
}

describe.skipIf(!hasParquet)("POST /api/search — retrieval over the parcels", () => {
  it("returns rows that satisfy every constraint in the question", async () => {
    const { parcels } = await search("aged roofs with an open roofing permit in Clermont");
    expect(parcels).not.toBeNull();
    const half = parcels as ParcelHalf;
    const expected = Number(
      await (
        await getContext()
      ).store.queryScalar(
        "SELECT count(*) FROM properties WHERE roof_age_years >= 15 " +
          "AND open_roofing_permit_count > 0 AND address_city = 'CLERMONT'",
      ),
    );
    expect(half.matched).toBe(expected);
    expect(half.matched).toBeGreaterThan(0);
    expect(half.rows.length).toBeGreaterThan(0);
    for (const row of half.rows) {
      expect(Number(row.roof_age_years)).toBeGreaterThanOrEqual(15);
      expect(Number(row.open_roofing_permit_count)).toBeGreaterThan(0);
      expect(String(row.address_city)).toBe("CLERMONT");
    }
  }, 120_000);

  it("answers an unsatisfiable question with nothing, rather than the nearest parcel", async () => {
    // BM25 over a per-parcel text profile answered a question like this with a
    // confident, wrong parcel; the honest answer is zero rows, with the
    // constraints still shown so a reader can see why.
    //
    // The city moved from Clermont to Astor: 5 Clermont parcels now satisfy
    // this, because correcting roof age surfaced parcels the old data hid, so
    // the question stopped being unsatisfiable. Astor has none, which keeps
    // what this test is actually for.
    const { parcels } = await search(
      "aged roofs with an open roofing permit in Astor owned out of state",
    );
    const half = parcels as ParcelHalf;
    expect(half.matched).toBe(0);
    expect(half.rows).toHaveLength(0);
    expect(half.filters).toMatchObject({
      minRoofAge: 15,
      hasOpenRoofingPermit: true,
      city: "ASTOR",
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
    expect(half.filters).toMatchObject({
      hasOpenRoofingPermit: true,
      minOpenRoofingPermitDays: 1825,
    });
    for (const row of half.rows) {
      expect(Number(row.longest_open_roofing_permit_days)).toBeGreaterThanOrEqual(1825);
    }
  }, 120_000);

  it("reports the true total, not the page size", async () => {
    const { parcels } = await search("out of state owners", 5);
    const half = parcels as ParcelHalf;
    expect(half.returned).toBeLessThanOrEqual(5);
    const expected = Number(
      await (
        await getContext()
      ).store.queryScalar("SELECT count(*) FROM properties WHERE owner_out_of_state"),
    );
    expect(half.matched).toBe(expected);
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
