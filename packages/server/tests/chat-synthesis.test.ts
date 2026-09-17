import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { ChatEmptyAnswerError, createChatAgent, SYSTEM_PROMPT } from "../src/chat/agent.js";
import { loadConfig } from "../src/config.js";
import type { AppContext } from "../src/context.js";
import { OracleDataStore } from "../src/data/duckdb.js";
import { getCityCentre } from "../src/data/queries.js";
import type * as QueryModule from "../src/data/queries.js";
import { Router } from "../src/http/router.js";
import { registerChatRoutes } from "../src/routes/chat.js";

// Exercise the real AI SDK ToolLoopAgent/generateText implementation. Only the
// model transport and dataset query are mocks; no external model or DB runs.
const transport = vi.hoisted(() => ({ model: null as MockLanguageModelV4 | null }));
vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: () => () => transport.model,
}));
vi.mock("../src/data/queries.js", async (importOriginal) => ({
  ...(await importOriginal<typeof QueryModule>()),
  getCityCentre: vi.fn(),
}));

type ModelResult = Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>>;
const usage: ModelResult["usage"] = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};
const RUN = "20260916T181000Z";
const ROOT = "bafybeigakr7d6nywkbanzmh4r7cpv7kz7qs5vxvwlxcxuovk2lobrj442u";
const QUESTION = "Where is the source-backed centre of Clermont?";
const ANSWER =
  "CLERMONT's centre is 28.55, -81.75, computed from 4 FL GIO parcel centroids in the selected snapshot. This is a parcel mean, not a GPS fix.";

function textStep(text: string): ModelResult {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "stop" },
    usage,
    warnings: [],
  };
}

function toolStep(index: number): ModelResult {
  return {
    content: [
      {
        type: "tool-call",
        toolCallId: `city-${index}`,
        toolName: "resolveCityCentre",
        input: JSON.stringify({ city: "CLERMONT" }),
      },
    ],
    finishReason: { unified: "tool-calls", raw: "tool_calls" },
    usage,
    warnings: [],
  };
}

function context(): AppContext {
  return {
    config: loadConfig({ OPENAI_API_KEY: "sk-test-only", ORACLE_CHAT_TIMEOUT_MS: "120000" }),
    store: new OracleDataStore({ source: "/tmp/never-opened.parquet" }),
    provenance: vi.fn().mockResolvedValue({
      runId: RUN,
      rootCid: ROOT,
      dataSource: `https://example.invalid/ipfs/${ROOT}/query.parquet`,
      dataSourceKind: "ipfs",
      sourceObservationsOnly: true,
    }),
  };
}

beforeEach(() => {
  vi.mocked(getCityCentre).mockResolvedValue({
    city: "CLERMONT",
    lat: 28.55,
    lon: -81.75,
    parcelsWithCoordinates: 4,
    provenance: {
      sql: "SELECT AVG(latitude) AS lat, AVG(longitude) AS lon FROM properties",
      sourceSystems: ["FL GIO"],
      runId: RUN,
      rootCid: ROOT,
      dataSource: `https://example.invalid/ipfs/${ROOT}/query.parquet`,
      dataSourceKind: "ipfs",
    },
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  transport.model = null;
});

describe("bounded grounded final synthesis", () => {
  it("answers a tool-only exhausted loop from the original tool messages and retains citations", async () => {
    transport.model = new MockLanguageModelV4({
      doGenerate: [...Array.from({ length: 9 }, (_, index) => toolStep(index)), textStep(ANSWER)],
    });
    const timeout = vi.spyOn(AbortSignal, "timeout");

    const response = await createChatAgent(context()).run([{ role: "user", content: QUESTION }]);

    expect(response.answer).toBe(ANSWER);
    expect(response.runId).toBe(RUN);
    expect(response.citations).toHaveLength(9);
    expect(response.citations[0]).toMatchObject({
      tool: "resolveCityCentre",
      sourceSystems: ["FL GIO"],
      rowCount: 4,
      runId: RUN,
      rootCid: ROOT,
    });
    expect(getCityCentre).toHaveBeenCalledTimes(9);
    expect(transport.model.doGenerateCalls).toHaveLength(10);
    const finalCall = transport.model.doGenerateCalls[9];
    expect(finalCall?.tools ?? []).toHaveLength(0);
    expect(finalCall?.toolChoice).toEqual({ type: "none" });
    expect(JSON.stringify(finalCall?.prompt)).toContain(QUESTION);
    expect(JSON.stringify(finalCall?.prompt)).toContain('"parcelsWithCoordinates":4');
    expect(JSON.stringify(finalCall?.prompt)).toContain('"toolCallId":"city-8"');
    expect(finalCall?.prompt[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining(SYSTEM_PROMPT),
    });
    expect(JSON.stringify(finalCall?.prompt)).toContain("unsupported-decision refusals");
    // No second deadline is allocated to the synthesis phase.
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledWith(120000);
  });

  it("does not spend another model call when the loop already produced text", async () => {
    transport.model = new MockLanguageModelV4({ doGenerate: textStep("Please name a city.") });
    const response = await createChatAgent(context()).run([{ role: "user", content: "Hi" }]);
    expect(response.answer).toBe("Please name a city.");
    expect(transport.model.doGenerateCalls).toHaveLength(1);
  });

  it("refuses terminal empty/whitespace output rather than returning a successful empty answer", async () => {
    transport.model = new MockLanguageModelV4({
      doGenerate: [textStep(""), textStep(" \n ")],
    });
    await expect(
      createChatAgent(context()).run([{ role: "user", content: QUESTION }]),
    ).rejects.toBeInstanceOf(ChatEmptyAnswerError);
    expect(transport.model.doGenerateCalls).toHaveLength(2);
  });

  it("does not restart an expired deadline for final synthesis", async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    transport.model = new MockLanguageModelV4({
      doGenerate: async () => {
        deadline.abort(new Error("turn deadline expired"));
        return textStep("");
      },
    });
    await expect(
      createChatAgent(context()).run([{ role: "user", content: QUESTION }]),
    ).rejects.toThrow(/turn deadline expired/);
    expect(transport.model.doGenerateCalls).toHaveLength(1);
    expect(AbortSignal.timeout).toHaveBeenCalledTimes(1);
  });

  it("returns an actionable non-200 error from the actual chat route if synthesis is also empty", async () => {
    transport.model = new MockLanguageModelV4({
      doGenerate: [textStep(""), textStep("")],
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const router = new Router();
    registerChatRoutes(router, context());
    const response = await router.handle({
      method: "POST",
      path: "/api/chat",
      query: new URLSearchParams(),
      headers: {},
      body: { messages: [{ role: "user", content: QUESTION }] },
    });
    expect(response.status).toBe(502);
    expect(JSON.parse(String(response.body))).toMatchObject({
      error: "chat_empty_answer",
      detail: expect.stringContaining("could not produce an answer"),
    });
    expect(JSON.parse(String(response.body))).not.toHaveProperty("answer");
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: "chat_empty_answer" }));
  });
});
