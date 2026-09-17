import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCityCentroidSql, buildSearchSql, PROPERTIES_VIEW } from "@oracle-lake/shared";
import type { ChatResponseWithDocuments } from "../src/chat/agent.js";
import { loadConfig } from "../src/config.js";
import { OracleDataStore } from "../src/data/duckdb.js";
import { getCityCentre, searchProperties } from "../src/data/queries.js";
import type * as QueryModule from "../src/data/queries.js";
import { Router } from "../src/http/router.js";
import { registerChatRoutes } from "../src/routes/chat.js";

const transport = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI: transport.create }));
vi.mock("../src/data/queries.js", async (importOriginal) => ({
  ...(await importOriginal<typeof QueryModule>()),
  getCityCentre: vi.fn(),
  searchProperties: vi.fn(),
}));

const QUESTION =
  "Which properties in Lake County within five miles of Clermont have roofs older than 15 years?";
const FOLLOWUP =
  "Which properties near that area have open roofing permits that have been open for many years, and who is the listed contractor?";
const RUN = "synthetic-followup-contract-fixture";
const ROOT = "not-a-public-root-cid-followup-fixture";
const provenance = {
  runId: RUN,
  rootCid: ROOT,
  dataSource: "synthetic-fixture://query-table.parquet",
  dataSourceKind: "local" as const,
  sourceSystems: ["Synthetic DOR/GIO boundary fixture"],
  sourceObservationsOnly: true,
};
// Full 25-row answer shape, deliberately synthetic. Do not present these IDs or
// addresses as real Lake County records or runtime/publication evidence.
const rows = Array.from({ length: 25 }, (_, index) => ({
  request_identifier: `SYNTHETIC-PARCEL-${index.toString().padStart(2, "0")}`,
  parcel_identifier: `SYNTHETIC-IDENTIFIER-${index}`,
  address_street: `${index} SYNTHETIC SOURCE-RECORD BOUNDARY FIXTURE STREET`,
  address_city: "CLERMONT",
  address_zip: "00000-FIXTURE",
  latitude: 28.55,
  longitude: -81.75,
  distance_miles: 0,
  built_year: 2000,
  roof_age_years: 26,
  roof_age_basis: "built_year_proxy",
  roof_age_confidence: "LOW",
  roof_age_caveat: "Synthetic building-year proxy, not a measured roof or accepted completion.",
  roof_age_as_of_date: "2026-09-17",
  source_systems: "SYNTHETIC-DOR;SYNTHETIC-GIO",
  open_roofing_permit_count: null,
}));

beforeEach(() => {
  vi.mocked(getCityCentre).mockResolvedValue({
    city: "CLERMONT",
    lat: 28.55,
    lon: -81.75,
    parcelsWithCoordinates: 25,
    provenance: { ...provenance, sql: buildCityCentroidSql(PROPERTIES_VIEW, "CLERMONT") },
  });
  vi.mocked(searchProperties).mockImplementation(async (_store, _provenance, options) => ({
    rows,
    matched: 25,
    limit: 25,
    offset: 0,
    provenance: { ...provenance, sql: buildSearchSql(PROPERTIES_VIEW, options) },
  }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("normal chat follow-up after a complete canonical answer", () => {
  it("accepts the full >8000-character 25-row assistant history then refuses unsupported long-open decisions without a model", async () => {
    const router = new Router();
    registerChatRoutes(router, {
      config: loadConfig({ OPENAI_API_KEY: "sk-test-only", ORACLE_CHAT_TIMEOUT_MS: "120000" }),
      store: new OracleDataStore({ source: "/tmp/never-opened-followup-fixture.parquet" }),
      provenance: vi.fn().mockResolvedValue(provenance),
    });
    const request = (messages: { role: "user" | "assistant"; content: string }[]) =>
      router.handle({
        method: "POST",
        path: "/api/chat",
        query: new URLSearchParams(),
        headers: {},
        body: { messages },
      });
    const first = await request([{ role: "user", content: QUESTION }]);
    expect(first.status).toBe(200);
    const answer = JSON.parse(first.body as string) as ChatResponseWithDocuments;
    expect(answer.answer.length).toBeGreaterThan(8000);
    expect(answer.answer.length).toBeLessThanOrEqual(32000);
    expect(answer.grounding).toMatchObject({
      mode: "canonical-query-rows",
      evidence: [{ tool: "searchProperties", runId: RUN, rootCid: ROOT, rows }],
    });
    for (const row of rows) expect(answer.answer).toContain(row.request_identifier);
    const next = await request([
      { role: "user", content: QUESTION },
      { role: "assistant", content: answer.answer },
      { role: "user", content: FOLLOWUP },
    ]);
    expect(next.status).toBe(200);
    const refusal = JSON.parse(next.body as string) as ChatResponseWithDocuments;
    expect(refusal.grounding).toMatchObject({
      mode: "source-only-refusal",
      runId: RUN,
      rootCid: ROOT,
    });
    expect(refusal.answer).toContain("not asserted to be currently open");
    expect(refusal.citations).toEqual([]);
    expect(searchProperties).toHaveBeenCalledTimes(1);
    expect(getCityCentre).toHaveBeenCalledTimes(1);
    expect(transport.create).not.toHaveBeenCalled();
  });
});
