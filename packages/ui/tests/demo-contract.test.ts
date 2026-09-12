import { describe, expect, it } from "vitest";

import { assertDemoContract, EXPECTED_MCP_TOOLS } from "../scripts/demo-contract.mjs";

const runId = "20260911T131000Z";
const rootCid = "bafybeih5xrlpzdvjoky75aq7j2cad36dnnzec4suqiwboy3ucayjgyeqnq";

function fixture() {
  return {
    expectedRunId: runId,
    expectedRootCid: rootCid,
    meta: {
      run: { runId, rootCid },
      coverage: {
        tables: {
          contractors: {
            availability: "supported_partial",
            jurisdictionsCovered: 1,
            jurisdictionsInCounty: 15,
            permitYears: Array.from({ length: 12 }, (_, index) =>
              String(index + 15).padStart(2, "0"),
            ),
            complete: true,
          },
          businessAccounts: {
            rows: 33_346,
            withSitusAddress: 32_738,
            matchedToParcel: 2_060,
            attributedAcrossParcels: 4_451,
            propertiesWithAccount: 2_726,
            sharedAddressGroups: 90,
          },
        },
      },
    },
    tools: {
      result: {
        tools: EXPECTED_MCP_TOOLS.map((name) => ({ name })),
      },
    },
    contractor: {
      posture: { contractor_names_present: 2_359, bbb_ratings_present: 0 },
      note: "Clermont is the only municipality with harvested contractor detail in this run.",
      gating: [
        {
          field: "bbb_rating",
          detail: "BBB is policy/API gated; the default route returned HTTP 403.",
        },
      ],
      provenance: { runId, rootCid },
    },
    business: {
      totals: { business_accounts: 4_451, properties_with_accounts: 2_726 },
      provenance: { runId, rootCid },
    },
  };
}

describe("recorded demo release contract", () => {
  it("accepts one exact full-history release with nine tools and honest coverage", () => {
    expect(assertDemoContract(fixture())).toEqual({
      runId,
      rootCid,
      toolCount: 9,
      contractorNames: 2_359,
      contractorJurisdictions: "1/15",
      contractorPermitYears: [
        "15",
        "16",
        "17",
        "18",
        "19",
        "20",
        "21",
        "22",
        "23",
        "24",
        "25",
        "26",
      ],
      bbbRatings: 0,
      business: {
        sourceAccounts: 33_346,
        withSitusAddress: 32_738,
        matchedToParcel: 2_060,
        attributedAcrossParcels: 4_451,
        propertiesWithAccount: 2_726,
        sharedAddressGroups: 90,
      },
    });
  });

  it("rejects stale identity and an eight-tool runtime", () => {
    const stale = fixture();
    stale.meta.run.rootCid = `bafybei${"a".repeat(52)}`;
    expect(() => assertDemoContract(stale)).toThrow(/api\/meta\/run/);

    const oldRuntime = fixture();
    oldRuntime.tools.result.tools.pop();
    expect(() => assertDemoContract(oldRuntime)).toThrow(/exactly nine expected tools/);
  });

  it("rejects one-year or misleading countywide contractor evidence", () => {
    const oneYear = fixture();
    oneYear.meta.coverage.tables.contractors.permitYears = ["26"];
    expect(() => assertDemoContract(oneYear)).toThrow(/exact 2015-2026/);

    const misleading = fixture();
    misleading.contractor.note = "Contractor coverage is countywide.";
    expect(() => assertDemoContract(misleading)).toThrow(/Clermont-only/);

    const fabricated = fixture();
    fabricated.contractor.posture.bbb_ratings_present = 1;
    expect(() => assertDemoContract(fabricated)).toThrow(/honestly absent/);
  });

  it("rejects business figures from another release or inconsistent coverage", () => {
    const stale = fixture();
    stale.business.provenance.runId = "20260910T000000Z";
    expect(() => assertDemoContract(stale)).toThrow(/business provenance/);

    const mismatched = fixture();
    mismatched.business.totals.business_accounts = 4_450;
    expect(() => assertDemoContract(mismatched)).toThrow(/do not match.*coverage snapshot/);

    const impossible = fixture();
    impossible.meta.coverage.tables.businessAccounts.matchedToParcel = 40_000;
    expect(() => assertDemoContract(impossible)).toThrow(/internally inconsistent/);
  });
});
