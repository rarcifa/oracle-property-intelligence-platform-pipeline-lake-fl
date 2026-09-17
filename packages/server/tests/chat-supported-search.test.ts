import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCityCentroidSql, buildSearchSql, PROPERTIES_VIEW } from "@oracle-lake/shared";
import { createChatAgent } from "../src/chat/agent.js";
import {
  interpretSupportedRoofRadiusRequest,
  withinTurnDeadline,
} from "../src/chat/supported-search.js";
import { loadConfig } from "../src/config.js";
import type { AppContext } from "../src/context.js";
import { OracleDataStore } from "../src/data/duckdb.js";
import { getCityCentre, searchProperties } from "../src/data/queries.js";
import type * as QueryModule from "../src/data/queries.js";

const transport = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI: transport.create }));
vi.mock("../src/data/queries.js", async (importOriginal) => ({
  ...(await importOriginal<typeof QueryModule>()),
  getCityCentre: vi.fn(),
  searchProperties: vi.fn(),
}));

const QUESTION =
  "Which properties in Lake County within five miles of Clermont have roofs older than 15 years?";
const RUN = "20260916T181000Z";
const ROOT = "bafybeigakr7d6nywkbanzmh4r7cpv7kz7qs5vxvwlxcxuovk2lobrj442u";
const provenance = {
  runId: RUN,
  rootCid: ROOT,
  dataSource: `https://example.invalid/ipfs/${ROOT}/query-table.parquet`,
  dataSourceKind: "ipfs" as const,
  sourceSystems: ["FL DOR NAL", "FL GIO"],
  sourceObservationsOnly: true,
};
const row = {
  request_identifier: "01-22-24-0001-000-00100",
  address_street: "123 SOURCE ST",
  address_city: "CLERMONT",
  latitude: 28.55,
  longitude: -81.75,
  distance_miles: 0,
  roof_age_years: 26,
  roof_age_basis: "built_year",
  roof_age_confidence: "LOW",
  open_roofing_permit_count: null,
};
function context(): AppContext {
  return {
    config: loadConfig({ OPENAI_API_KEY: "sk-test-only", ORACLE_CHAT_TIMEOUT_MS: "120000" }),
    store: new OracleDataStore({ source: "/tmp/never-opened.parquet" }),
    provenance: vi.fn().mockResolvedValue(provenance),
  };
}
const interpret = (question: string) =>
  interpretSupportedRoofRadiusRequest([{ role: "user", content: question }]);

beforeEach(() => {
  vi.mocked(getCityCentre).mockResolvedValue({
    city: "CLERMONT",
    lat: 28.55,
    lon: -81.75,
    parcelsWithCoordinates: 4,
    provenance: { ...provenance, sql: buildCityCentroidSql(PROPERTIES_VIEW, "CLERMONT") },
  });
  vi.mocked(searchProperties).mockImplementation(async (_store, _provenance, options) => ({
    rows: [row],
    matched: 200,
    limit: 25,
    offset: 0,
    provenance: { ...provenance, sql: buildSearchSql(PROPERTIES_VIEW, options) },
  }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("bounded supported roof-age/radius interpretation", () => {
  it("resolves the exact brief prompt without guessing coordinates or weakening >15", () => {
    expect(interpret(QUESTION)).toEqual({
      city: "CLERMONT",
      radiusMiles: 5,
      roofAgeThreshold: 15,
      comparison: "older-than",
      minRoofAge: 16,
    });
  });

  it.each([
    [
      "Show properties within 2.5 miles of Mount Dora with roofs older than fifteen years.",
      2.5,
      16,
    ],
    [
      "Find homes in Lake County, FL within five miles of Clermont that have roofs at least 15 years",
      5,
      15,
    ],
    ["List parcels within 3 miles of Eustis with roofs over 15.5 years", 3, 16],
  ])("preserves explicit comparison/radius in %s", (question, radius, minimum) => {
    expect(interpret(question)).toMatchObject({ radiusMiles: radius, minRoofAge: minimum });
  });

  it.each([
    "Which properties within five miles of Clermont have roofs older than 15 years and regional owners?",
    "Which properties within five miles of Clermont have roofs older than 15 years except businesses?",
    "Which properties in Orange County within five miles of Clermont have roofs older than 15 years?",
    "Which properties outside five miles of Clermont have roofs older than 15 years?",
    "Which properties within five miles of Clermont have roofs not older than 15 years?",
    "Which properties within five miles have roofs older than 15 years?",
    "Which properties within zero miles of Clermont have roofs older than 15 years?",
    "Which properties within 201 miles of Clermont have roofs older than 15 years?",
    "Which properties within five miles of Clermont have roofs older than 500 years?",
    "Which properties near that area have roofs older than 15 years?",
  ])("does not silently drop unsupported or missing restrictions: %s", (question) => {
    expect(interpret(question)).toBeNull();
  });
});

describe("reliable canonical supported search", () => {
  it("uses selected-source city coordinates and canonical purpose-built rows every time", async () => {
    const app = context();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const agent = createChatAgent(app);
    const response = await agent.run([{ role: "user", content: QUESTION }]);
    const again = await agent.run([{ role: "user", content: QUESTION }]);
    expect(again).toEqual(response);
    expect(getCityCentre).toHaveBeenCalledWith(app.store, provenance, "CLERMONT");
    expect(searchProperties).toHaveBeenCalledWith(app.store, provenance, {
      lat: 28.55,
      lon: -81.75,
      radiusMiles: 5,
      minRoofAge: 16,
      limit: 25,
    });
    expect(searchProperties).toHaveBeenCalledTimes(2);
    expect(response.answer).toContain("roof_age_years > 15 (integer-year lower bound 16)");
    expect(response.answer).toContain("radius is not restricted to city boundaries");
    expect(response.answer).toContain(`request_identifier: ${row.request_identifier}`);
    expect(response.answer).toContain("distance_miles: 0");
    expect(response.answer).toContain(
      "low-confidence building-age proxies, not measured roof ages",
    );
    expect(response.grounding).toMatchObject({
      mode: "canonical-query-rows",
      evidence: [
        { tool: "searchProperties", rows: [row], runId: RUN, rootCid: ROOT, rowCount: 200 },
      ],
    });
    if (response.grounding?.mode === "canonical-query-rows") {
      expect(response.grounding.evidence[0]?.sql).toContain("roof_age_years >= 16");
      expect(response.grounding.evidence[0]?.sql).toContain("AS distance_miles");
      expect(response.grounding.evidence[0]?.sql).not.toContain("upper(coalesce(address_city");
    }
    expect(response.citations.map((citation) => citation.tool)).toEqual([
      "resolveCityCentre",
      "searchProperties",
    ]);
    expect(response.citations[1]?.parcelIds).toEqual([row.request_identifier]);
    expect(transport.create).not.toHaveBeenCalled();
    expect(timeout).toHaveBeenCalledTimes(2);
    expect(timeout).toHaveBeenNthCalledWith(1, 120000);
  });

  it.each([
    { lat: null },
    { lon: null },
    { lat: undefined },
    { lon: undefined },
    { lat: NaN },
    { lon: Infinity },
    { lat: 91 },
    { parcelsWithCoordinates: 0 },
    { city: "ANOTHER CITY" },
    { provenance: { ...provenance, sql: "SELECT 1", runId: "another-run" } },
    { provenance: { ...provenance, sql: "SELECT 1", rootCid: "another-root" } },
  ])(
    "refuses an unavailable/invalid/mismatched city centre without substitutions: %j",
    async (patch) => {
      const centre = await vi.mocked(getCityCentre).getMockImplementation()?.(
        context().store,
        provenance,
        "CLERMONT",
      );
      if (!centre) throw new Error("Missing centre fixture");
      vi.mocked(getCityCentre).mockResolvedValue({ ...centre, ...patch });
      const response = await createChatAgent(context()).run([{ role: "user", content: QUESTION }]);
      expect(response.grounding?.mode).toBe("no-verified-records");
      expect(response.answer).toContain("No coordinates or city filter were substituted");
      expect(searchProperties).not.toHaveBeenCalled();
      expect(transport.create).not.toHaveBeenCalled();
    },
  );

  it("fails loudly rather than bind returned rows to the wrong run", async () => {
    vi.mocked(searchProperties).mockResolvedValue({
      rows: [row],
      matched: 1,
      limit: 25,
      offset: 0,
      provenance: { ...provenance, sql: "SELECT * FROM properties", runId: "another-run" },
    });
    await expect(
      createChatAgent(context()).run([{ role: "user", content: QUESTION }]),
    ).rejects.toThrow("different snapshot");
  });

  it("does not invent samples when the validated canonical query returns no rows", async () => {
    vi.mocked(searchProperties).mockResolvedValue({
      rows: [],
      matched: 0,
      limit: 25,
      offset: 0,
      provenance: { ...provenance, sql: "SELECT * FROM properties WHERE roof_age_years >= 16" },
    });
    const response = await createChatAgent(context()).run([{ role: "user", content: QUESTION }]);
    expect(response.grounding?.mode).toBe("no-verified-records");
    expect(response.answer).toContain("not proof that no matching records exist");
    expect(response.answer).not.toContain(row.request_identifier);
    expect(transport.create).not.toHaveBeenCalled();
  });

  it("does not make a property query after the shared deadline expires during city resolution", async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    vi.mocked(getCityCentre).mockImplementation(() => {
      controller.abort(new Error("turn deadline expired"));
      return new Promise(() => undefined);
    });
    await expect(
      createChatAgent(context()).run([{ role: "user", content: QUESTION }]),
    ).rejects.toThrow("turn deadline expired");
    expect(AbortSignal.timeout).toHaveBeenCalledTimes(1);
    expect(searchProperties).not.toHaveBeenCalled();
  });

  it("checks an already expired deadline before launching query work", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already expired"));
    const operation = vi.fn().mockResolvedValue("never used");
    await expect(withinTurnDeadline(operation, controller.signal)).rejects.toThrow(
      "already expired",
    );
    expect(operation).not.toHaveBeenCalled();
  });
});
