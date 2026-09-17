import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { createChatAgent } from "../src/chat/agent.js";
import {
  finalizeRecordAnswer,
  requestsUnsupportedOpenPermits,
  type QueryEvidence,
} from "../src/chat/grounding.js";
import { loadConfig } from "../src/config.js";
import type { AppContext } from "../src/context.js";
import { OracleDataStore } from "../src/data/duckdb.js";
import { runReadOnlySql, searchProperties } from "../src/data/queries.js";
import type * as QueryModule from "../src/data/queries.js";

const transport = vi.hoisted(() => ({ model: null as MockLanguageModelV4 | null }));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI: () => () => transport.model }));
vi.mock("../src/data/queries.js", async (importOriginal) => ({
  ...(await importOriginal<typeof QueryModule>()),
  searchProperties: vi.fn(),
  runReadOnlySql: vi.fn(),
}));

type ModelResult = Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>>;
const RUN = "20260916T181000Z";
const ROOT = "bafybeigakr7d6nywkbanzmh4r7cpv7kz7qs5vxvwlxcxuovk2lobrj442u";
const SQL = "SELECT * FROM properties WHERE roof_age_years >= 15 LIMIT 25";
const row = {
  request_identifier: "01-22-24-0001-000-00100",
  address_street: "123 SOURCE ST",
  address_city: "CLERMONT",
  latitude: 28.55,
  longitude: -81.75,
  roof_age_years: 26,
  roof_age_basis: "built_year_proxy",
  roof_age_confidence: "low",
  open_roofing_permit_count: null,
};
const provenance = {
  sql: SQL,
  sourceSystems: ["FL DOR NAL", "FL GIO"],
  runId: RUN,
  rootCid: ROOT,
  dataSource: `https://example.invalid/ipfs/${ROOT}/query-table.parquet`,
  dataSourceKind: "ipfs" as const,
};
const evidence: QueryEvidence = {
  tool: "searchProperties",
  sql: SQL,
  sourceSystems: provenance.sourceSystems,
  runId: RUN,
  rootCid: ROOT,
  rowCount: 1,
  rows: [row],
};

function result(content: ModelResult["content"], tools = false): ModelResult {
  return {
    content,
    finishReason: { unified: tools ? "tool-calls" : "stop", raw: tools ? "tool_calls" : "stop" },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 10, text: 10, reasoning: 0 },
    },
    warnings: [],
  };
}
function queryStep(): ModelResult {
  return result(
    [
      {
        type: "tool-call",
        toolCallId: "properties-1",
        toolName: "searchProperties",
        input: '{"minRoofAge":15}',
      },
    ],
    true,
  );
}
function context(sourceOnly = true): AppContext {
  return {
    config: loadConfig({ OPENAI_API_KEY: "sk-test-only" }),
    store: new OracleDataStore({ source: "/tmp/never-opened.parquet" }),
    provenance: vi.fn().mockResolvedValue({ ...provenance, sourceObservationsOnly: sourceOnly }),
  };
}

beforeEach(() => {
  vi.mocked(searchProperties).mockResolvedValue({
    rows: [row],
    matched: 1,
    limit: 25,
    offset: 0,
    provenance,
  });
});
afterEach(() => {
  transport.model = null;
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("canonical record answer finalization", () => {
  it("discards fabricated model records despite correct query citations", async () => {
    transport.model = new MockLanguageModelV4({
      doGenerate: [
        queryStep(),
        result([
          {
            type: "text",
            text: "999999 homes qualify. Parcel 8152046971 at 840 DEER RUN, coordinates 99,99, has a measured 50-year roof. Unknown id FAKE-02 is also eligible.",
          },
        ]),
      ],
    });
    const answer = await createChatAgent(context()).run([
      { role: "user", content: "Which properties have roofs older than 15 years?" },
    ]);
    expect(answer.citations[0]?.parcelIds).toEqual([row.request_identifier]);
    expect(answer.answer).toContain(`request_identifier: ${row.request_identifier}`);
    expect(answer.answer).toContain(`address_street: ${row.address_street}`);
    expect(answer.answer).toContain("latitude: 28.55; longitude: -81.75");
    expect(answer.answer).toContain(
      "roof_age_years: 26; roof_age_basis: built_year_proxy; roof_age_confidence: low",
    );
    expect(answer.answer).toContain("tool-reported row count: 1 (not asserted as total matches)");
    expect(answer.answer).not.toMatch(/8152046971|840 DEER RUN|999999|FAKE-02|99,99|measured 50/);
    expect(answer.grounding).toEqual({ mode: "canonical-query-rows", evidence: [evidence] });
  });

  it("renders real rows even if the model ends its loop with empty prose", async () => {
    transport.model = new MockLanguageModelV4({ doGenerate: [queryStep(), result([])] });
    const answer = await createChatAgent(context()).run([
      { role: "user", content: "List properties with aged roofs." },
    ]);
    expect(answer.answer).toContain(row.request_identifier);
    expect(answer.grounding?.mode).toBe("canonical-query-rows");
    expect(transport.model.doGenerateCalls).toHaveLength(2);
  });

  it("refuses unsupported model samples when the actual record query returned no rows", async () => {
    vi.mocked(searchProperties).mockResolvedValue({
      rows: [],
      matched: 0,
      limit: 25,
      offset: 0,
      provenance,
    });
    transport.model = new MockLanguageModelV4({
      doGenerate: [
        queryStep(),
        result([{ type: "text", text: "Parcel 8152046971 at 840 DEER RUN qualifies." }]),
      ],
    });
    const answer = await createChatAgent(context()).run([
      { role: "user", content: "Show properties with roofs older than 15 years." },
    ]);
    expect(answer.grounding?.mode).toBe("no-verified-records");
    expect(answer.answer).toContain("not proof that no matching records exist");
    expect(answer.answer).not.toMatch(/8152046971|840 DEER RUN/);
  });

  it("does not turn city metadata, dataset counts, or an unknown model id into a property list", async () => {
    transport.model = new MockLanguageModelV4({
      doGenerate: result([
        { type: "text", text: "There are 7 houses. UNKNOWN-ID at INVENTED ROAD qualifies." },
      ]),
    });
    const answer = await createChatAgent(context()).run([
      { role: "user", content: "Which properties near Clermont have aged roofs?" },
    ]);
    expect(answer.grounding?.mode).toBe("no-verified-records");
    expect(answer.answer).not.toMatch(/UNKNOWN-ID|INVENTED ROAD|7 houses/);
    expect(
      finalizeRecordAnswer([{ ...evidence, tool: "resolveCityCentre" }], true)?.grounding.mode,
    ).toBe("no-verified-records");
    expect(
      finalizeRecordAnswer([{ ...evidence, tool: "getDatasetInfo" }], true)?.grounding.mode,
    ).toBe("no-verified-records");
  });

  it("does not describe aggregate or business rows as actual properties without canonical parcel rows", () => {
    const result = finalizeRecordAnswer(
      [{ ...evidence, tool: "runSql", rows: [{ count: 12 }] }],
      true,
    );
    expect(result?.grounding.mode).toBe("no-verified-records");
    expect(result?.answer).not.toContain("12 properties");
  });

  it.each([
    { parcel_id: row.request_identifier, address_street: row.address_street },
    { request_identifier: "FABRICATED-ID", address_street: "840 DEER RUN" },
    { ...row, address_street: "MODEL-REPLACED STREET" },
  ])(
    "does not promote arbitrary SQL aliases or literals to canonical property evidence: %j",
    (sqlRow) => {
      const result = finalizeRecordAnswer([{ ...evidence, tool: "runSql", rows: [sqlRow] }], true);
      expect(result?.grounding.mode).toBe("no-verified-records");
      expect(result?.answer).not.toMatch(/FABRICATED-ID|840 DEER RUN|MODEL-REPLACED STREET/);
      if (result?.grounding.mode === "no-verified-records") {
        expect(result.grounding.evidence[0]?.rows).toEqual([]);
      }
    },
  );

  it.each([
    [
      "SELECT request_identifier AS parcel_id, address_street FROM properties LIMIT 25",
      { parcel_id: row.request_identifier, address_street: row.address_street },
    ],
    [
      "SELECT 'FABRICATED-ID' AS request_identifier, '840 DEER RUN' AS address_street FROM properties LIMIT 25",
      { request_identifier: "FABRICATED-ID", address_street: "840 DEER RUN" },
    ],
  ])(
    "keeps SQL replay evidence but refuses an SDK-selected unsafe projection: %s",
    async (sql, sqlRow) => {
      vi.mocked(runReadOnlySql).mockResolvedValue({
        rows: [sqlRow],
        rowCount: 1,
        truncated: false,
        sql,
        provenance: { ...provenance, sql },
      });
      transport.model = new MockLanguageModelV4({
        doGenerate: [
          result(
            [
              {
                type: "tool-call",
                toolCallId: "unsafe-projection",
                toolName: "runSql",
                input: JSON.stringify({ sql }),
              },
            ],
            true,
          ),
          result([{ type: "text", text: "FABRICATED-ID at 840 DEER RUN qualifies." }]),
        ],
      });
      const response = await createChatAgent(context()).run([
        { role: "user", content: "Which properties have roofs older than 15 years?" },
      ]);
      expect(response.grounding?.mode).toBe("no-verified-records");
      expect(response.answer).not.toMatch(/FABRICATED-ID|840 DEER RUN/);
      expect(response.citations).toMatchObject([
        { tool: "runSql", sql, runId: RUN, rootCid: ROOT, parcelIds: [] },
      ]);
      if (response.grounding?.mode === "no-verified-records") {
        expect(response.grounding.evidence[0]).toMatchObject({ sql, rows: [] });
      }
    },
  );

  it("bounds the exact structured evidence to 25 rows total and preserves null rather than replacing it", () => {
    const many = {
      ...evidence,
      rows: Array.from({ length: 30 }, (_, i) => ({
        ...row,
        request_identifier: `CANONICAL-${i}`,
      })),
    };
    const result = finalizeRecordAnswer([many, many], true);
    expect(result?.grounding.mode).toBe("canonical-query-rows");
    if (result?.grounding.mode === "canonical-query-rows") {
      expect(result.grounding.evidence.flatMap((entry) => entry.rows)).toHaveLength(25);
      expect(result.grounding.evidence[0]?.rows[0]?.open_roofing_permit_count).toBeNull();
    }
  });

  it("retains the SDK path for document-only questions without record facts", async () => {
    transport.model = new MockLanguageModelV4({
      doGenerate: result([
        { type: "text", text: "The documentation describes an immutable CID snapshot." },
      ]),
    });
    const answer = await createChatAgent(context()).run([
      { role: "user", content: "What does an immutable CID mean in the publication runbook?" },
    ]);
    expect(answer.answer).toContain("immutable CID snapshot");
    expect(answer.grounding).toBeUndefined();
    expect(transport.model.doGenerateCalls).toHaveLength(1);
  });
});

describe("source-only permit capability refusal before model generation", () => {
  it.each([
    "Which properties near that area have open roofing permits that have been open for many years, and who is the listed contractor?",
    "Show properties with long-open roofing permits and BBB ratings.",
    "Which permits are still open after 365 days?",
  ])("refuses the initial unsupported request: %s", async (question) => {
    transport.model = new MockLanguageModelV4({
      doGenerate: result([{ type: "text", text: "I will query open permits." }]),
    });
    const answer = await createChatAgent(context()).run([{ role: "user", content: question }]);
    expect(answer.grounding).toMatchObject({
      mode: "source-only-refusal",
      runId: RUN,
      rootCid: ROOT,
      capabilities: { currentOpenPermitStatus: "unsupported", openPermitDuration: "unsupported" },
    });
    expect(answer.answer).toContain("cannot identify properties with long-open roofing permits");
    expect(transport.model.doGenerateCalls).toHaveLength(0);
    expect(searchProperties).not.toHaveBeenCalled();
  });

  it.each([
    "More than five years.",
    "Use 365 days.",
    "10 years",
    "Over 24 months please.",
    "5",
    ">1095",
    "yes, 5",
  ])("does not bypass the gate through a duration clarification: %s", async (clarification) => {
    transport.model = new MockLanguageModelV4({
      doGenerate: result([{ type: "text", text: "I will query open permits." }]),
    });
    const answer = await createChatAgent(context()).run([
      { role: "user", content: "Which properties have open roofing permits?" },
      { role: "assistant", content: "How many days or years should I use?" },
      { role: "user", content: clarification },
    ]);
    expect(answer.grounding?.mode).toBe("source-only-refusal");
    expect(transport.model.doGenerateCalls).toHaveLength(0);
  });

  it("does not prohibit an independent supported roof-age question after an open-permit question", () => {
    expect(
      requestsUnsupportedOpenPermits([
        { role: "user", content: "Which properties have open roofing permits?" },
        { role: "user", content: "Instead, which properties have roofs older than 15 years?" },
      ]),
    ).toBe(false);
  });

  it("does not impose the source-only refusal on a decision-enabled snapshot", async () => {
    transport.model = new MockLanguageModelV4({
      doGenerate: result([{ type: "text", text: "No property rows queried." }]),
    });
    const answer = await createChatAgent(context(false)).run([
      { role: "user", content: "Which properties have open roofing permits?" },
    ]);
    expect(answer.grounding?.mode).toBe("no-verified-records");
    expect(transport.model.doGenerateCalls).toHaveLength(1);
  });
});
