/** Exercise the real view for the small metadata envelope returned after an override. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IPFS_GATEWAYS } from "@oracle-lake/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunMetaResponse } from "../src/data/types.js";
import { Header } from "../src/components/Header.js";
import { OverviewView } from "../src/views/OverviewView.js";

const mocks = vi.hoisted(() => ({ useDataSource: vi.fn() }));
vi.mock("../src/data/DataSourceProvider.js", () => ({ useDataSource: mocks.useDataSource }));
vi.mock("../src/hooks/useAsync.js", () => ({
  useAsync: () => ({ data: null, loading: false, error: null, reload: () => undefined }),
}));

let meta: RunMetaResponse;
beforeEach(() => {
  meta = {
    sourceObservationsOnly: true,
    run: { runId: "20260916T181000Z", rootCid: "synthetic-public-root" },
    coverage: null,
    verification: null,
    runHistory: null,
    dataSource: "synthetic-public-parquet",
    dataSourceKind: "ipfs",
    gateways: [...IPFS_GATEWAYS],
    unusableGateways: [],
    chatEnabled: false,
  };
  mocks.useDataSource.mockImplementation(() => ({
    source: { dataSource: meta.dataSource },
    meta,
    metaError: null,
    mode: "server",
  }));
});

describe("partial run rendering", () => {
  it("renders identity-only metadata without throwing or inventing publication fields", () => {
    const html = renderToStaticMarkup(createElement(OverviewView));
    expect(html).toContain("Source-only partial run");
    expect(html).toContain("20260916T181000Z");
    expect(html).toContain("No coverage snapshot matches the served run");
    expect(html).toContain("No verification report was found");
    expect(html).toContain("/ipfs/synthetic-public-root/query-table.parquet");
    expect(html).not.toContain("/ipfs/undefined");
    expect(html).not.toContain(">manifest</a>");
  });

  it("handles a known local run without offering links or clipboard actions for null CIDs", () => {
    meta.localEvidencePreview = true;
    meta.run = { runId: "synthetic-local-run", rootCid: null };
    const html = renderToStaticMarkup(createElement(OverviewView));
    const header = renderToStaticMarkup(createElement(Header, { activePath: "/overview" }));
    expect(html).toContain("Local unaccepted preview");
    expect(html).toContain("No public root CID is recorded");
    expect(html).not.toContain("/ipfs/null");
    expect(header).toMatch(/disabled=""[^>]*aria-label="Copy root CID null"/);
  });

  it("renders verified gateway evidence when it actually exists", () => {
    meta.run = {
      ...meta.run!,
      verifiedGateways: ["https://ipfs.filebase.io", "https://gateway.pinata.cloud"],
      manifestCid: "synthetic-manifest-cid",
    };
    const html = renderToStaticMarkup(createElement(OverviewView));
    expect(html).toContain("https://ipfs.filebase.io, https://gateway.pinata.cloud");
    expect(html).toContain("/ipfs/synthetic-manifest-cid");
  });
});
