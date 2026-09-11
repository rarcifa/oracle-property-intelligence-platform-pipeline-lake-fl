/** MCP protocol and tool-handler tests. */
import { afterAll, describe, expect, it } from "vitest";
import {
  DEFAULT_PROTOCOL_VERSION,
  handleRpcPayload,
  negotiateProtocolVersion,
} from "../src/mcp/server.js";
import { callTool, MCP_TOOL_NAMES, MCP_TOOLS } from "../src/mcp/tools.js";
import type { AppContext } from "../src/context.js";
import { bodyJson, closeStore, getContext, getRouter, hasParquet, request } from "./harness.js";

interface RpcResponse {
  jsonrpc: string;
  id: string | number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

describe("protocol negotiation", () => {
  it("echoes a supported version", () => {
    expect(negotiateProtocolVersion("2024-11-05")).toBe("2024-11-05");
  });

  it("falls back to the newest supported version", () => {
    expect(negotiateProtocolVersion("1999-01-01")).toBe(DEFAULT_PROTOCOL_VERSION);
    expect(negotiateProtocolVersion(undefined)).toBe(DEFAULT_PROTOCOL_VERSION);
  });
});

describe("tool definitions", () => {
  it("advertises the Elephant-convention tool names", () => {
    expect([...MCP_TOOL_NAMES].sort()).toEqual(
      [
        "findAgedRoofs",
        "findOpenRoofPermits",
        "findPropertiesInRadius",
        "getOracleDatasetInfo",
        "getOracleProperty",
        "getPropertyPermits",
        "getPropertyQuerySchema",
        "listOracleProperties",
        "queryProperties",
      ].sort(),
    );
  });

  it("gives every tool a described object input schema", () => {
    for (const tool of MCP_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("advertises an explicit roofing-duration field", () => {
    const list = MCP_TOOLS.find((tool) => tool.name === "listOracleProperties");
    const openRoof = MCP_TOOLS.find((tool) => tool.name === "findOpenRoofPermits");
    const listProperties = list?.inputSchema.properties as Record<string, unknown> | undefined;
    const openRoofProperties = openRoof?.inputSchema.properties as
      Record<string, { deprecated?: boolean }> | undefined;
    expect(listProperties).toHaveProperty("minOpenRoofingPermitDays");
    expect(openRoofProperties).toHaveProperty("minOpenRoofingPermitDays");
    expect(openRoofProperties?.minOpenPermitDays?.deprecated).toBe(true);
  });
});

describe.skipIf(!hasParquet)("MCP over the data layer", () => {
  let context: AppContext | null = null;
  const ctx = async (): Promise<AppContext> => {
    context ??= await getContext();
    return context;
  };

  afterAll(() => {
    closeStore();
  });

  it("answers initialize with capabilities and server info", async () => {
    const response = (await handleRpcPayload(await ctx(), {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      },
    })) as RpcResponse;
    expect(response.result?.protocolVersion).toBe("2025-06-18");
    expect((response.result?.serverInfo as { name: string }).name).toBe("oracle-lake-fl");
  });

  it("returns no response for a notification", async () => {
    expect(
      await handleRpcPayload(await ctx(), { jsonrpc: "2.0", method: "notifications/initialized" }),
    ).toBeNull();
  });

  it("lists tools", async () => {
    const response = (await handleRpcPayload(await ctx(), {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    })) as RpcResponse;
    expect((response.result?.tools as unknown[]).length).toBe(MCP_TOOLS.length);
  });

  it("rejects an unknown method with -32601", async () => {
    const response = (await handleRpcPayload(await ctx(), {
      jsonrpc: "2.0",
      id: 3,
      method: "nope/nope",
    })) as RpcResponse;
    expect(response.error?.code).toBe(-32601);
  });

  it("rejects a malformed message with -32600", async () => {
    const response = (await handleRpcPayload(await ctx(), { hello: "world" })) as RpcResponse;
    expect(response.error?.code).toBe(-32600);
  });

  it("handles a batch and drops notification slots", async () => {
    const responses = (await handleRpcPayload(await ctx(), [
      { jsonrpc: "2.0", id: "a", method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: "b", method: "tools/list" },
    ])) as RpcResponse[];
    expect(responses).toHaveLength(2);
    expect(responses.map((response) => response.id)).toEqual(["a", "b"]);
  });

  it("calls a tool and returns both text content and structured content", async () => {
    const response = (await handleRpcPayload(await ctx(), {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "getPropertyQuerySchema", arguments: {} },
    })) as RpcResponse;
    const result = response.result as {
      content: { type: string; text: string }[];
      structuredContent: { columnCount: number };
      isError: boolean;
    };
    expect(result.isError).toBe(false);
    expect(result.content[0]?.type).toBe("text");
    expect(result.structuredContent.columnCount).toBe(63);
  });

  it("rejects a call to an unadvertised tool", async () => {
    const response = (await handleRpcPayload(await ctx(), {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "rmDashRf", arguments: {} },
    })) as RpcResponse;
    expect(response.error?.code).toBe(-32601);
  });
});

describe.skipIf(!hasParquet)("MCP tool handlers", () => {
  let context: AppContext | null = null;
  const ctx = async (): Promise<AppContext> => {
    context ??= await getContext();
    return context;
  };

  afterAll(() => {
    closeStore();
  });

  it("getOracleDatasetInfo returns live counts and the documented limitations", async () => {
    const result = await callTool(await ctx(), "getOracleDatasetInfo", {});
    const payload = result.payload as {
      liveCounts: Record<string, number>;
      limitations: string[];
    };
    expect(payload.liveCounts.properties).toBeGreaterThan(100_000);
    expect(payload.limitations.length).toBeGreaterThan(0);
  });

  it("queryProperties runs a read-only statement", async () => {
    const result = await callTool(await ctx(), "queryProperties", {
      sql: "SELECT count(*) AS n FROM properties",
    });
    expect(result.isError).toBeFalsy();
    expect((result.payload as { rows: { n: number }[] }).rows[0]?.n).toBeGreaterThan(0);
  });

  it("queryProperties refuses a mutating statement", async () => {
    const result = await callTool(await ctx(), "queryProperties", {
      sql: "DROP TABLE properties",
    });
    expect(result.isError).toBe(true);
    expect((result.payload as { error: string }).error).toBe("sql_rejected");
  });

  it("queryProperties reports a SQL error rather than throwing", async () => {
    const result = await callTool(await ctx(), "queryProperties", {
      sql: "SELECT no_such_column FROM properties",
    });
    expect(result.isError).toBe(true);
    expect((result.payload as { error: string }).error).toBe("query_failed");
  });

  it("findAgedRoofs defaults to the county threshold and returns the basis", async () => {
    const result = await callTool(await ctx(), "findAgedRoofs", { limit: 5 });
    const payload = result.payload as {
      thresholdYears: number;
      rows: { roof_age_years: number; roof_age_basis: string }[];
      matched: number;
    };
    expect(payload.thresholdYears).toBe(15);
    expect(payload.matched).toBeGreaterThan(0);
    for (const row of payload.rows) {
      expect(row.roof_age_years).toBeGreaterThanOrEqual(15);
      expect(row.roof_age_basis).toBeTruthy();
    }
  });

  it("findOpenRoofPermits returns only open roofing permits, with the gating reasons", async () => {
    const result = await callTool(await ctx(), "findOpenRoofPermits", { limit: 5 });
    const payload = result.payload as {
      rows: { open_roofing_permit_count: number }[];
      gating: { field: string }[];
    };
    expect(payload.rows.length).toBeGreaterThan(0);
    for (const row of payload.rows) {
      expect(row.open_roofing_permit_count).toBeGreaterThan(0);
    }
    expect(payload.gating.map((notice) => notice.field)).toEqual(["contractor_name", "bbb_rating"]);
  });

  it("findPropertiesInRadius returns distances inside the radius", async () => {
    const seed = await callTool(await ctx(), "listOracleProperties", {
      requireCoordinates: "true",
      limit: 1,
    });
    const first = (seed.payload as { rows: { latitude: number; longitude: number }[] }).rows[0];
    const result = await callTool(await ctx(), "findPropertiesInRadius", {
      lat: first?.latitude,
      lon: first?.longitude,
      radiusMiles: 1,
      limit: 10,
    });
    const payload = result.payload as { rows: { distance_miles: number }[] };
    expect(payload.rows.length).toBeGreaterThan(0);
    for (const row of payload.rows) {
      expect(row.distance_miles).toBeLessThanOrEqual(1);
    }
  });

  it("findPropertiesInRadius rejects a missing centre", async () => {
    const result = await callTool(await ctx(), "findPropertiesInRadius", { lat: 28.5 });
    expect(result.isError).toBe(true);
  });

  it("getOracleProperty reports a not-found parcel as a tool error", async () => {
    const result = await callTool(await ctx(), "getOracleProperty", {
      parcelId: "00-00-00-0000-000-00000",
    });
    expect(result.isError).toBe(true);
  });

  it("getPropertyPermits exposes bounded permit-grain records", async () => {
    const seed = await callTool(await ctx(), "listOracleProperties", {
      hasPermits: true,
      limit: 1,
    });
    const parcelId = String(
      (seed.payload as { rows: { request_identifier: string }[] }).rows[0]?.request_identifier,
    );
    const result = await callTool(await ctx(), "getPropertyPermits", {
      parcelId,
      limit: 5,
    });
    expect(result.isError).toBeFalsy();
    const payload = result.payload as {
      permitsAvailable: boolean;
      permits: { permit_id: string }[];
      provenance: { sql: string };
    };
    if (payload.permitsAvailable) {
      expect(payload.permits.length).toBeGreaterThan(0);
      expect(payload.permits.length).toBeLessThanOrEqual(5);
      expect(payload.permits[0]?.permit_id).toBeTruthy();
    }
    expect(payload.provenance.sql).toContain("FROM permits");
  });

  it("an unknown tool name is a tool error, not a throw", async () => {
    const result = await callTool(await ctx(), "nope", {});
    expect(result.isError).toBe(true);
  });
});

/**
 * An argument this server does not implement must be an error, never a silent
 * no-op. Every tool advertises `additionalProperties: false`, but the schemas
 * behind them stripped unknown keys instead of refusing them, so a misspelled
 * filter returned the whole unfiltered result set and read as a valid answer —
 * which is exactly how `findOpenRoofPermits` came to be reported as ignoring
 * its filter. It does not; `minOpenRoofingPermitDays` narrows correctly, and
 * both halves are asserted here. The original field remains a documented alias
 * on the purpose-built tool only.
 */
describe.skipIf(!hasParquet)("MCP argument validation", () => {
  let context: AppContext | null = null;
  const ctx = async (): Promise<AppContext> => {
    context ??= await getContext();
    return context;
  };

  afterAll(() => {
    closeStore();
  });

  const misspelled: [string, Record<string, unknown>][] = [
    ["findOpenRoofPermits", { minOpenDays: 365 }],
    ["findAgedRoofs", { minRoofAgeYears: 30 }],
    ["findPropertiesInRadius", { lat: 28.5, lon: -81.7, radiusMiles: 1, minRoofAgeYears: 30 }],
    ["listOracleProperties", { cityName: "CLERMONT" }],
    ["getOracleProperty", { parcelId: "05-18-25-0004-000-00400", verbose: true }],
    ["getPropertyPermits", { parcelId: "05-18-25-0004-000-00400", verbose: true }],
    ["queryProperties", { sql: "SELECT 1 AS n", maxRows: 5 }],
    ["getPropertyQuerySchema", { county: "lake" }],
    ["getOracleDatasetInfo", { includeCoverage: true }],
  ];

  it.each(misspelled)("%s rejects an argument it does not implement", async (tool, args) => {
    const result = await callTool(await ctx(), tool, args);
    expect(result.isError).toBe(true);
    expect((result.payload as { error: string }).error).toBe("invalid_arguments");
    expect((result.payload as { detail: string }).detail).toMatch(/[Uu]nrecognized key/);
  });

  it("minOpenRoofingPermitDays narrows the result set rather than being ignored", async () => {
    const matched = async (minOpenRoofingPermitDays: number): Promise<number> => {
      const result = await callTool(await ctx(), "findOpenRoofPermits", {
        minOpenRoofingPermitDays,
        limit: 1,
      });
      expect(result.isError).toBeFalsy();
      return (result.payload as { matched: number }).matched;
    };
    const [all, aYear, eightYears] = await Promise.all([matched(0), matched(365), matched(3000)]);
    expect(all).toBeGreaterThan(0);
    expect(aYear).toBeLessThan(all);
    expect(eightYears).toBeLessThan(aYear);
    expect(eightYears).toBeGreaterThan(0);
  });

  it("keeps the original purpose-built field as an unambiguous compatibility alias", async () => {
    const [current, legacy] = await Promise.all([
      callTool(await ctx(), "findOpenRoofPermits", {
        minOpenRoofingPermitDays: 1825,
        limit: 1,
      }),
      callTool(await ctx(), "findOpenRoofPermits", { minOpenPermitDays: 1825, limit: 1 }),
    ]);
    expect((current.payload as { matched: number }).matched).toBe(
      (legacy.payload as { matched: number }).matched,
    );
  });

  it("rejects both duration fields together instead of choosing one silently", async () => {
    const result = await callTool(await ctx(), "findOpenRoofPermits", {
      minOpenRoofingPermitDays: 1825,
      minOpenPermitDays: 365,
    });
    expect(result.isError).toBe(true);
    expect((result.payload as { error: string }).error).toBe("invalid_arguments");
  });
});

describe.skipIf(!hasParquet)("/mcp HTTP endpoint", () => {
  afterAll(() => {
    closeStore();
  });

  it("answers a JSON-RPC POST with 200", async () => {
    const router = await getRouter();
    const response = await request(router, "POST", "/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(response.status).toBe(200);
    expect(bodyJson<RpcResponse>(response).result).toBeDefined();
  });

  it("answers a notification-only POST with 202 and no body", async () => {
    const router = await getRouter();
    const response = await request(router, "POST", "/mcp", {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(response.status).toBe(202);
    expect(response.body).toBe("");
  });

  it("describes itself on GET rather than 405-ing", async () => {
    const router = await getRouter();
    const response = await request(router, "GET", "/mcp");
    expect(response.status).toBe(200);
    expect(bodyJson<{ protocol: string }>(response).protocol).toBe("jsonrpc-2.0");
  });
});
