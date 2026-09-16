/**
 * Publish-time plausibility tests.
 *
 * The incident: an incremental run with no cached permit base fetched a two-day
 * window, treated it as the whole dataset, and published 281 permits over
 * 17,671. Readiness passed, the DAG hashed, CIDs matched byte for byte, two
 * gateways verified the bytes. Every check confirmed the bytes were what they
 * claimed to be; none could tell a small county from a truncated one.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import parquet from "@dsnp/parquetjs";
import { afterEach, describe, expect, it } from "vitest";
import { assertBusinessTableGate } from "../src/counties/lake/adapter.mjs";
import {
  assertPublicationPredecessor,
  assertTablesPlausible,
  coverageTableRows,
  MINIMUM_TABLE_RETENTION,
} from "../scripts/lake/publish-run.mjs";

const publicationTarget = {
  rootCid: "bafybeinewrootcid000000000000000000000000000000000000000000",
  ipnsNetworkKey: "k51qzi5uqu5dgd1ekyyuhwggov571fjxof2p5ef4ke7enlq60k03r47fosb2un",
  ipnsPredecessor: {
    cid: "bafybeipriorrootcid0000000000000000000000000000000000000000",
    sequence: 7,
  },
};

const previous = {
  tables: [
    { name: "properties", rows: 215806 },
    { name: "permits", rows: 17671 },
    { name: "coordinates", rows: 209503 },
  ],
};

const coverage = (permits) => ({
  tables: {
    properties: { rows: 215806 },
    permits: { rows: permits },
    coordinates: { rows: 209503 },
    businessAccounts: { matchedToParcel: 2060 },
    contractors: { rows: 3634 },
  },
});

const businessCoverage = (rows, matchedToParcel = 2060) => ({
  tables: {
    ...coverage(17671).tables,
    businessAccounts: {
      rows,
      matchedToParcel,
      accountTableAvailable: true,
      queryableSourceAccounts: rows,
    },
  },
});

describe("publish plausibility gate", () => {
  it("counts all queryable accounts when unmatched businesses have their own table", () => {
    const rows = coverageTableRows(businessCoverage(33346));
    expect(rows.find((table) => table.name === "businessAccounts").rows).toBe(33346);
    expect(() =>
      assertTablesPlausible(rows, { tables: [{ name: "businessAccounts", rows: 33346 }] }, {}),
    ).not.toThrow();
  });

  it("does not count captured but unpublished unmatched accounts in a legacy export", () => {
    const legacy = coverage(17671);
    legacy.tables.businessAccounts.rows = 33346;
    expect(coverageTableRows(legacy).find((table) => table.name === "businessAccounts").rows).toBe(
      2060,
    );
  });

  it("still refuses a genuinely truncated all-account table", () => {
    expect(() =>
      assertTablesPlausible(
        coverageTableRows(businessCoverage(300, 20)),
        { tables: [{ name: "businessAccounts", rows: 33346 }] },
        {},
      ),
    ).toThrow(/table 'businessAccounts' fell from 33346 to 300 rows/);
  });

  it.each([undefined, -1, 2060])(
    "refuses an inconsistent all-account coverage count %s",
    (count) => {
      const inconsistent = businessCoverage(33346);
      inconsistent.tables.businessAccounts.queryableSourceAccounts = count;
      expect(() => coverageTableRows(inconsistent)).toThrow(/business account count/i);
    },
  );
  it("refuses the exact truncation that was published: 17,671 permits down to 281", () => {
    expect(() => assertTablesPlausible(coverageTableRows(coverage(281)), previous, {})).toThrow(
      /table 'permits' fell from 17671 to 281 rows/,
    );
  });

  it("names the retained fraction and how to override, so the operator can act", () => {
    let message = "";
    try {
      assertTablesPlausible(coverageTableRows(coverage(281)), previous, {});
    } catch (error) {
      message = error.message;
    }
    expect(message).toContain("1.6% retained");
    expect(message).toContain("ORACLE_ALLOW_TABLE_SHRINK");
  });

  it("allows a healthy run through untouched", () => {
    expect(() =>
      assertTablesPlausible(coverageTableRows(coverage(17671)), previous, {}),
    ).not.toThrow();
  });

  it("allows growth, which is the normal incremental case", () => {
    expect(() =>
      assertTablesPlausible(coverageTableRows(coverage(18500)), previous, {}),
    ).not.toThrow();
  });

  it("allows a modest contraction — permits are voided, parcels are combined", () => {
    const modest = Math.ceil(17671 * (MINIMUM_TABLE_RETENTION + 0.2));
    expect(() =>
      assertTablesPlausible(coverageTableRows(coverage(modest)), previous, {}),
    ).not.toThrow();
  });

  it("publishes a genuine contraction only when the operator says so explicitly", () => {
    const env = { ORACLE_ALLOW_TABLE_SHRINK: "1" };
    expect(() =>
      assertTablesPlausible(coverageTableRows(coverage(281)), previous, env),
    ).not.toThrow();
  });

  it("has nothing to compare on a first run, and does not invent a baseline", () => {
    expect(() => assertTablesPlausible(coverageTableRows(coverage(281)), null, {})).not.toThrow();
  });

  it("checks every published table, not only permits", () => {
    const collapsed = { tables: { ...coverage(17671).tables, coordinates: { rows: 12 } } };
    expect(() => assertTablesPlausible(coverageTableRows(collapsed), previous, {})).toThrow(
      /table 'coordinates' fell from 209503 to 12 rows/,
    );
  });

  it("refuses loss of certified contractor coverage", () => {
    const prior = {
      ...previous,
      tables: [...previous.tables, { name: "contractors", rows: 3634 }],
    };
    const collapsed = {
      tables: { ...coverage(17671).tables, contractors: { rows: 0 } },
    };
    expect(() => assertTablesPlausible(coverageTableRows(collapsed), prior, {})).toThrow(
      /table 'contractors' fell from 3634 to 0 rows/,
    );
  });
});

describe("business account Parquet gate", () => {
  const directories = [];
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });
  async function businessTable(ids) {
    const directory = await mkdtemp(path.join(tmpdir(), "lake-business-gate-"));
    directories.push(directory);
    const file = path.join(directory, "accounts.parquet");
    const writer = await parquet.ParquetWriter.openFile(
      new parquet.ParquetSchema({ account_id: { type: "UTF8", optional: true } }),
      file,
    );
    for (const account_id of ids) await writer.appendRow({ account_id });
    await writer.close();
    return file;
  }

  it("reconciles the actual account table instead of trusting a coverage claim", async () => {
    await expect(assertBusinessTableGate(await businessTable(["A", "B"]), 2)).resolves.toEqual({
      rows: 2,
      distinctAccounts: 2,
      nullAccountIds: 0,
    });
  });

  it("refuses truncated bytes even when coverage claims the complete account count", async () => {
    await expect(assertBusinessTableGate(await businessTable(["A"]), 33346)).rejects.toThrow(
      /Business table row count 1 != coverage account count 33346/,
    );
  });

  it.each([
    ["A", "A"],
    ["A", null],
    ["A", " "],
  ])("refuses duplicate or missing account identities %j", async (...ids) => {
    await expect(assertBusinessTableGate(await businessTable(ids), 2)).rejects.toThrow(
      /unique non-empty account_id/,
    );
  });
});

describe("publication predecessor fence", () => {
  const prior = { rootCid: "bafybeipriorrootcid0000000000000000000000000000000000000000" };

  it("accepts only the exact predecessor before a new mutation", () => {
    expect(
      assertPublicationPredecessor(
        prior,
        {
          networkKey: publicationTarget.ipnsNetworkKey,
          cid: prior.rootCid,
          sequence: publicationTarget.ipnsPredecessor.sequence,
        },
        publicationTarget,
        "AUTHORIZED",
      ),
    ).toBe("recorded-predecessor");
    expect(() =>
      assertPublicationPredecessor(
        prior,
        {
          networkKey: publicationTarget.ipnsNetworkKey,
          cid: "bafybeistale",
          sequence: publicationTarget.ipnsPredecessor.sequence,
        },
        publicationTarget,
        "AUTHORIZED",
      ),
    ).toThrow(/restore the durable publication history/);
  });

  it("reconciles an already-applied target only at the IPNS stage", () => {
    const readback = {
      networkKey: publicationTarget.ipnsNetworkKey,
      cid: publicationTarget.rootCid,
      sequence: publicationTarget.ipnsPredecessor.sequence + 1,
    };
    expect(
      assertPublicationPredecessor(prior, readback, publicationTarget, "HISTORY_RECORDED"),
    ).toBe("target-already-applied");
    expect(() =>
      assertPublicationPredecessor(prior, readback, publicationTarget, "AUTHORIZED"),
    ).toThrow(/not the signed predecessor/);
  });

  it("fails closed on a missing or wrong-name pointer", () => {
    expect(() =>
      assertPublicationPredecessor(prior, null, publicationTarget, "AUTHORIZED"),
    ).toThrow(/could not be read back/);
    expect(() =>
      assertPublicationPredecessor(
        prior,
        {
          networkKey: "k51wrong",
          cid: prior.rootCid,
          sequence: publicationTarget.ipnsPredecessor.sequence,
        },
        publicationTarget,
        "AUTHORIZED",
      ),
    ).toThrow(/network key/);
  });
});
