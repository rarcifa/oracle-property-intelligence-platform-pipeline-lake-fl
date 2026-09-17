import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { gatedFieldNotices } from "@oracle-lake/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContractorView } from "../src/views/ContractorView.js";

const mocks = vi.hoisted(() => ({
  useDataSource: vi.fn(),
  loaders: [] as (() => Promise<unknown>)[],
  search: vi.fn(),
  runSql: vi.fn(),
  viewData: null as unknown,
}));
vi.mock("../src/data/DataSourceProvider.js", () => ({ useDataSource: mocks.useDataSource }));
vi.mock("../src/hooks/useAsync.js", () => ({
  useAsync: (loader: () => Promise<unknown>) => {
    const data = mocks.loaders.length === 0 ? mocks.viewData : null;
    mocks.loaders.push(loader);
    return { data, loading: false, error: null, reload: () => undefined };
  },
}));

beforeEach(() => {
  mocks.loaders.length = 0;
  mocks.viewData = null;
  mocks.search.mockReset().mockResolvedValue(null);
  mocks.runSql.mockReset().mockResolvedValue(null);
  mocks.useDataSource.mockReturnValue({
    meta: null,
    metaError: null,
    source: {
      getContractorView: async () => null,
      getStats: async () => null,
      search: mocks.search,
      runSql: mocks.runSql,
    },
  });
});

describe("contractor decision eligibility", () => {
  it("labels roof age as a low-confidence proxy without changing permanently null field badges", () => {
    mocks.viewData = {
      posture: {},
      gating: gatedFieldNotices("primary_roof_completion_needs_review;bbb_policy_api_gated"),
      note: "Source observations only",
      provenance: null,
    };
    const html = renderToStaticMarkup(createElement(ContractorView));
    expect(html).toContain("column roof_age_years · low-confidence built-year proxy only");
    expect(html).not.toContain("column roof_age_years · stays null");
    expect(html).toContain("column bbb_rating · stays null");
  });

  it("waits for metadata instead of issuing an unsupported current-open query at boot", async () => {
    const html = renderToStaticMarkup(createElement(ContractorView));
    await Promise.all(mocks.loaders.map((loader) => loader()));
    expect(mocks.search).not.toHaveBeenCalled();
    expect(mocks.runSql).not.toHaveBeenCalled();
    expect(html).toContain("Permit data selection pending");
    expect(html).not.toContain("No parcel in the selected decision-enabled table matches");
  });

  it("loads only historical source observations for a source-only selected snapshot", async () => {
    const context = mocks.useDataSource();
    mocks.useDataSource.mockReturnValue({
      ...context,
      meta: { sourceObservationsOnly: true },
    });
    const html = renderToStaticMarkup(createElement(ContractorView));
    await Promise.all(mocks.loaders.map((loader) => loader()));
    expect(mocks.search).not.toHaveBeenCalled();
    expect(mocks.runSql).toHaveBeenCalledOnce();
    expect(mocks.runSql.mock.calls[0]?.[0]).toContain("FROM permits");
    expect(html).toContain("Retained historical permit observations");
    expect(html).toContain("not verified legal-company or license identities");
    expect(html).toContain("Current-open duration unavailable");
  });

  it("retains the current-open request for a known decision-enabled dataset", async () => {
    const context = mocks.useDataSource();
    mocks.useDataSource.mockReturnValue({ ...context, meta: {} });
    renderToStaticMarkup(createElement(ContractorView));
    await Promise.all(mocks.loaders.map((loader) => loader()));
    expect(mocks.search).toHaveBeenCalledWith(
      expect.objectContaining({ hasOpenRoofingPermit: true }),
    );
    expect(mocks.runSql).not.toHaveBeenCalled();
  });
});
