import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SearchResponse } from "@oracle-lake/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SearchView } from "./SearchView.js";

const { useAsyncMock } = vi.hoisted(() => ({ useAsyncMock: vi.fn() }));

vi.mock("../hooks/useAsync.js", () => ({ useAsync: useAsyncMock }));
vi.mock("../data/DataSourceProvider.js", () => ({
  useDataSource: () => ({ source: {} }),
}));
vi.mock("./SemanticSearchPanel.js", () => ({ SemanticSearchPanel: () => null }));

const EMPTY_RESULTS: SearchResponse = {
  rows: [],
  matched: 0,
  limit: 50,
  offset: 0,
  provenance: {
    sql: "SELECT * FROM properties WHERE FALSE",
    dataSource: "unit-fixture://properties",
    dataSourceKind: "local",
    sourceSystems: [],
    runId: "UNIT_FIXTURE",
    rootCid: null,
  },
};

function renderResults(options: {
  data?: SearchResponse | null;
  loading?: boolean;
  error?: { message: string; detail: string | null } | null;
}): string {
  useAsyncMock.mockReturnValueOnce({ data: null, loading: false, error: null, reload: vi.fn() });
  useAsyncMock.mockReturnValueOnce({
    data: options.data ?? null,
    loading: options.loading ?? false,
    error: options.error ?? null,
    reload: vi.fn(),
  });
  return renderToStaticMarkup(createElement(SearchView));
}

beforeEach(() => useAsyncMock.mockReset());

describe("Search results state", () => {
  it("does not turn unsupported source semantics into an empty-result claim", () => {
    const html = renderResults({
      error: {
        message: "invalid_search",
        detail: "Current/open roofing status is unsupported; unknown does not mean no permits.",
      },
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Current/open roofing status is unsupported");
    expect(html).not.toContain("No parcels match these filters.");
    expect(html).not.toContain("matching parcels");
  });

  it("hides failed-query rows, pagination and SQL even if stale data is present", () => {
    const html = renderResults({
      data: { ...EMPTY_RESULTS, rows: [{ request_identifier: "UNIT_STALE_PARCEL" }], matched: 1 },
      error: { message: "Query failed", detail: "The result is unknown." },
    });
    expect(html).toContain("The result is unknown.");
    expect(html).not.toContain("No parcels match these filters.");
    expect(html).not.toContain("SELECT * FROM properties WHERE FALSE");
    expect(html).not.toContain("matching parcels");
    expect(html).not.toContain("UNIT_STALE_PARCEL");
  });

  it("keeps the honest empty state for a successful zero-row query", () => {
    const html = renderResults({ data: EMPTY_RESULTS });
    expect(html).toContain("No parcels match these filters.");
    expect(html).not.toContain('role="alert"');
  });

  it("renders a loading skeleton rather than a zero-result claim", () => {
    const html = renderResults({ loading: true });
    expect(html).toContain('aria-label="Loading"');
    expect(html).not.toContain("No parcels match these filters.");
  });
});
