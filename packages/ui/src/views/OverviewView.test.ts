import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunMetaResponse } from "../data/types.js";
import { OverviewView } from "./OverviewView.js";

const { useDataSourceMock } = vi.hoisted(() => ({ useDataSourceMock: vi.fn() }));
vi.mock("../data/DataSourceProvider.js", () => ({ useDataSource: useDataSourceMock }));
vi.mock("../hooks/useAsync.js", () => ({
  useAsync: () => ({ data: null, loading: false, error: null, reload: vi.fn() }),
}));

const MANIFEST = "not-a-public-manifest-cid-unit-fixture";
const CAR = "not-a-public-car-cid-unit-fixture";

function metadata(): RunMetaResponse {
  return {
    run: { runId: "UNIT_PARTIAL_RUN", rootCid: "not-a-public-root-cid-unit-fixture" },
    sourceObservationsOnly: true,
    coverage: null,
    verification: null,
    runHistory: null,
    dataSource: "unit-fixture://properties",
    dataSourceKind: "local",
    gateways: [],
    unusableGateways: [],
    chatEnabled: false,
    publicationEvidence: {
      runId: "UNIT_PARTIAL_RUN",
      rootCid: "not-a-public-root-cid-unit-fixture",
      manifestCid: MANIFEST,
      manifestSha256: `sha256:${"a".repeat(64)}`,
      manifestBytes: 123,
      carCid: CAR,
      carBytes: 341012658,
      carSha256: `sha256:${"b".repeat(64)}`,
      artifactCount: 40,
      verifiedGateways: ["https://gateway-a.example", "https://gateway-b.example"],
      recordedAt: "2026-09-17T15:31:26.176Z",
      scope: "standalone-public-gateway-observations",
      retentionVerified: false,
      publicationPromoted: false,
    },
  };
}

function renderMeta(meta: RunMetaResponse): string {
  useDataSourceMock.mockReturnValue({
    source: { dataSource: "unit-fixture://properties" },
    meta,
    metaError: null,
    mode: "server",
  });
  return renderToStaticMarkup(createElement(OverviewView));
}

beforeEach(() => useDataSourceMock.mockReset());

describe("Overview selected publication evidence", () => {
  it("shows standalone manifest/CAR bytes without claiming finalized or retained publication", () => {
    const html = renderMeta(metadata());
    expect(html).toContain("Source-only partial run");
    expect(html).toContain(MANIFEST);
    expect(html).toContain(CAR);
    expect(html).toContain("341,012,658 bytes");
    expect(html).toContain(`sha256:${"b".repeat(64)}`);
    expect(html).toContain("https://gateway-a.example, https://gateway-b.example");
    expect(html).toContain("Independent retention remains unverified");
    expect(html).toContain("does not promote the run to a finalized release or change IPNS/latest");
  });

  it("does not render evidence from a different run or root", () => {
    for (const changed of ["runId", "rootCid"] as const) {
      const meta = metadata();
      meta.publicationEvidence![changed] = "DIFFERENT_IDENTITY";
      const html = renderMeta(meta);
      expect(html).not.toContain(MANIFEST);
      expect(html).not.toContain(CAR);
      expect(html).not.toContain("341,012,658 bytes");
      expect(html).not.toContain("https://gateway-a.example");
    }
  });

  it("does not replace a matching published pointer with standalone fallback fields", () => {
    const meta = metadata();
    meta.run = {
      ...meta.run!,
      manifestCid: "pointer-manifest-fixture",
      carCid: "pointer-car-fixture",
    };
    const html = renderMeta(meta);
    expect(html).toContain("pointer-manifest-fixture");
    expect(html).toContain("pointer-car-fixture");
    expect(html).not.toContain(MANIFEST);
    expect(html).not.toContain(CAR);
    expect(html).not.toContain("341,012,658 bytes");
  });

  it("retains missing-evidence messaging when no exact-run packet exists", () => {
    const meta = metadata();
    meta.publicationEvidence = null;
    const html = renderMeta(meta);
    expect(html).toContain("No verification report was found for this run");
    expect(html).not.toContain(MANIFEST);
    expect(html).not.toContain("Recorded public gateway byte matches only");
  });

  it("describes exact finalized retention evidence without claiming county or status acceptance", () => {
    const meta = metadata();
    meta.publicationEvidence = {
      ...meta.publicationEvidence!,
      scope: "finalized-publication-receipt",
      retentionVerified: true,
      publicationPromoted: true,
    };
    const html = renderMeta(meta);
    expect(html).toContain("Source-only partial run");
    expect(html).toContain("Finalized publication receipts bind this snapshot");
    expect(html).toContain(
      "do not establish county completeness or accepted current permit status",
    );
    expect(html).not.toContain("Independent retention remains unverified");
  });

  it("shows permit-only incremental deltas for every recorded table without inventing removals", () => {
    const meta = metadata();
    meta.runHistory = {
      schemaVersion: "synthetic-unit-history",
      runs: [
        {
          runId: "UNIT_INCREMENTAL_HISTORY",
          mode: "incremental",
          tables: [
            { name: "properties", rows: 215806, inserted: 0, updated: 0, unchanged: 215806 },
            { name: "permits", rows: 76431, inserted: 265, updated: 801, unchanged: 75365 },
            { name: "businessAccounts", rows: 33346, inserted: 0, updated: 0, removed: 0 },
          ],
        },
        { runId: "UNIT_OLD_HISTORY_WITHOUT_TABLES" },
      ],
    };
    const html = renderMeta(meta);
    expect(html).toContain("<th>Table</th>");
    expect(html).toContain('class="num">Removed</th>');
    expect(html).toContain(
      '<td>permits</td><td class="num">76,431</td><td class="num">265</td><td class="num">801</td><td class="num">75,365</td><td class="num">—</td>',
    );
    expect(html).toContain("<td>properties</td>");
    expect(html).toContain("<td>businessAccounts</td>");
    expect(html).toContain("UNIT_OLD_HISTORY_WITHOUT_TABLES");
    expect(html).toContain("<td>unknown</td>");
  });
});
