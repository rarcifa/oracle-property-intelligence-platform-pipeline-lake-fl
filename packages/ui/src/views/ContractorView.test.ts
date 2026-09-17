import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlResponse } from "../data/types.js";
import { assertReadOnlySql } from "@oracle-lake/shared";
import { ContractorView, historicalPermitSql } from "./ContractorView.js";

const { source, states } = vi.hoisted(() => ({
  source: {
    getContractorView: vi.fn(async () => null),
    getStats: vi.fn(async () => null),
    search: vi.fn(async () => null),
    runSql: vi.fn(async () => null),
  },
  states: {
    summaryError: null as { message: string; detail: string | null } | null,
    rowsError: null as { message: string; detail: string | null } | null,
  },
}));

const PROVENANCE = {
  sql: "UNIT_SYNTHETIC_QUERY",
  dataSource: "unit-fixture://synthetic-permits",
  dataSourceKind: "local" as const,
  sourceSystems: [],
  runId: "UNIT_SYNTHETIC_HISTORICAL",
  rootCid: null,
};
const SUMMARY: SqlResponse = {
  rows: [
    {
      retained_permits: 123,
      clermont_permits: 99,
      clermont_roof_reroof: 31,
      clermont_source_issued: 12,
      clermont_roof_reroof_source_issued: 9,
      clermont_roof_reroof_source_issued_with_date: 7,
    },
  ],
  rowCount: 1,
  sql: "UNIT_SYNTHETIC_COUNT",
  provenance: PROVENANCE,
};
const ROWS: SqlResponse = {
  rows: [
    {
      permit_number: "UNIT_SYNTHETIC_PERMIT",
      permit_type: "ROOF/REROOF",
      jurisdiction: "Clermont",
      permit_status: "ISSUED",
      issued_date: "07/12/2020",
      contractor_name: "UNIT_SOURCE_LISTED_NAME",
      parcel_identifier: "UNIT_UNLINKED",
      linkage_status: "valid_unlinked",
      source_url: "https://source.example/unit",
      bbb_rating: null,
    },
  ],
  rowCount: 1,
  sql: "UNIT_SYNTHETIC_ROWS",
  provenance: PROVENANCE,
};

vi.mock("../data/DataSourceProvider.js", () => ({
  useDataSource: () => ({ source, meta: { sourceObservationsOnly: true }, metaError: null }),
}));
vi.mock("../hooks/useAsync.js", () => ({
  useAsync: (factory: () => Promise<unknown>) => {
    const before = source.runSql.mock.calls.length;
    void factory();
    const call = source.runSql.mock.calls.at(-1) as unknown as [string] | undefined;
    const isSql = source.runSql.mock.calls.length > before;
    const summary = isSql && call?.[0].includes("count(*)");
    return {
      data: isSql ? (summary ? SUMMARY : ROWS) : null,
      loading: false,
      error: isSql ? (summary ? states.summaryError : states.rowsError) : null,
      reload: vi.fn(),
    };
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  states.summaryError = null;
  states.rowsError = null;
});

function render(): string {
  return renderToStaticMarkup(createElement(ContractorView));
}

describe("source-only historical permit alternative", () => {
  it("shows queried retained counts and literal type/date without promoting current status or identity", () => {
    const html = render();
    expect(html).toContain("Clermont retained permits");
    expect(html).toContain("99");
    expect(html).toContain("Historical permit type");
    expect(html).toContain("ROOF/REROOF");
    expect(html).toContain("07/12/2020");
    expect(html).toContain("historical source-listed status, not currently open");
    expect(html).toContain("BBB: unknown");
    expect(html).toContain("UNIT_UNLINKED");
    expect(source.search).not.toHaveBeenCalled();
  });

  it("counts the selected permit table and keeps all records accessible by default", () => {
    render();
    const calls = source.runSql.mock.calls as unknown as [string, number][];
    const count = calls.find(([sql]) => sql.includes("count(*)"))?.[0];
    expect(() => assertReadOnlySql(count!)).not.toThrow();
    expect(count).toContain("source_system = 'lake_clermont_etrakit_permits'");
    expect(count).toContain("upper(trim(permit_type)) = 'ROOF/REROOF'");
    expect(count).toContain("upper(trim(permit_status)) = 'ISSUED'");
    expect(count).toContain("issued_date IS NOT NULL");
    const rows = calls.find(([sql]) => !sql.includes("count(*)"))?.[0];
    expect(rows).toContain("permit_type");
    expect(rows).not.toContain("WHERE");
    expect(rows).not.toMatch(/days_open|is_open|contractor_license|completed_date/);
  });

  it("does not render stale samples or matching totals as empty data after an error", () => {
    states.rowsError = { message: "Historical query failed", detail: "Result unknown." };
    const html = render();
    expect(html).toContain("Result unknown.");
    expect(html).not.toContain("UNIT_SYNTHETIC_PERMIT");
    expect(html).not.toContain("No parcels match");
    expect(html).not.toContain("matching permits");
  });

  it("uses the exact historical literal intersection without inferring current openness", () => {
    const sql = historicalPermitSql(50, true);
    expect(() => assertReadOnlySql(sql)).not.toThrow();
    expect(sql).toContain("WHERE source_system = 'lake_clermont_etrakit_permits'");
    expect(sql).toContain("upper(trim(permit_type)) = 'ROOF/REROOF'");
    expect(sql).toContain("upper(trim(permit_status)) = 'ISSUED'");
    expect(sql).toContain("issued_date IS NOT NULL");
    expect(sql).toContain("trim(CAST(issued_date AS VARCHAR)) <> ''");
    expect(sql).toContain("OFFSET 50");
    expect(sql).not.toMatch(/is_open|days_open|license|completed_date|is_roofing/);
  });

  it("never fabricates zero or a matching total when historical counting fails", () => {
    states.summaryError = { message: "Count failed", detail: "Historical count is unknown." };
    const html = render();
    expect(html).toContain("Historical count is unknown.");
    expect(html).toContain("UNIT_SYNTHETIC_PERMIT");
    expect(html).not.toContain("matching permits");
    expect(html).toContain("Matching retained historical count is still loading or unavailable");
  });
});
