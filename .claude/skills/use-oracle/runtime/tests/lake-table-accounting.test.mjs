/**
 * Table accounting tests.
 *
 * The failure these exist to prevent: a run reported inserted:0/updated:0 while
 * the permit layer had genuinely moved 17,457 -> 17,671 source-side. The counts
 * were right — every one of those permits was validUnlinked, so no property row
 * could change — but only `properties` was accounted for, so a real movement in
 * a published table left no trace at all.
 */
import { describe, expect, it } from "vitest";
import { buildTableAccounting } from "../scripts/lake/publish-run.mjs";
import { runTableSchema, tableBasis } from "../src/core/run-history.mjs";

const DELTAS = { inserted: 0, updated: 0, unchanged: 215806, removed: 0 };

const coverage = (permits, business = 2060) => ({
  tables: {
    properties: { rows: 215806 },
    permits: { rows: permits },
    coordinates: { rows: 209503 },
    businessAccounts: { matchedToParcel: business },
  },
});

describe("table accounting", () => {
  it("accounts for every published table, not only the hashed one", () => {
    const tables = buildTableAccounting(coverage(17671), DELTAS, null);
    expect(tables.map((table) => table.name)).toEqual([
      "properties",
      "permits",
      "coordinates",
      "businessAccounts",
    ]);
  });

  it("makes a permit movement visible even when no property row changed", () => {
    const previous = { tables: [{ name: "permits", rows: 17457 }] };
    const tables = buildTableAccounting(coverage(17671), DELTAS, previous);
    const permits = tables.find((table) => table.name === "permits");
    expect(permits.rowsDelta).toBe(214);
    expect(permits.previousRows).toBe(17457);
    // The property table is still, correctly, reporting no row-level change.
    expect(tables.find((table) => table.name === "properties").updated).toBe(0);
  });

  it("does not report four zeroes for a table it never hashed", () => {
    const tables = buildTableAccounting(coverage(17671), DELTAS, null);
    const permits = tables.find((table) => table.name === "permits");
    expect(permits.basis).toBe("row-count");
    expect(permits.inserted).toBeUndefined();
    expect(permits.unchanged).toBeUndefined();
  });

  it("keeps real row-level deltas on the table that is hashed", () => {
    const tables = buildTableAccounting(coverage(17671), { ...DELTAS, updated: 12 }, null);
    const properties = tables.find((table) => table.name === "properties");
    expect(properties.basis).toBe("row-hash");
    expect(properties.updated).toBe(12);
  });

  it("omits movement on a first run, rather than inventing a baseline", () => {
    const permits = buildTableAccounting(coverage(17671), DELTAS, null).find(
      (table) => table.name === "permits",
    );
    expect(permits.rowsDelta).toBeUndefined();
    expect(permits.previousRows).toBeUndefined();
  });

  it("every record validates, and a row-hash table without counts is refused", () => {
    for (const table of buildTableAccounting(coverage(17671), DELTAS, null)) {
      expect(() => runTableSchema.parse(table)).not.toThrow();
    }
    expect(() => runTableSchema.parse({ name: "properties", rows: 1, basis: "row-hash" })).toThrow();
  });

  it("validates a pre-basis record without rewriting it", () => {
    const legacy = { name: "properties", rows: 215806, inserted: 0, updated: 0, unchanged: 215806, removed: 0 };
    const parsed = runTableSchema.parse(legacy);
    // Must round-trip byte-identical: appendRun compares the validated history
    // against the stored bytes, so any injected field breaks an append.
    expect(parsed).toEqual(legacy);
    expect(parsed.basis).toBeUndefined();
    expect(tableBasis(parsed)).toBe("row-hash");
  });
});

describe("appending a run after the schema grew a field", () => {
  it("does not rewrite prior runs, so the append-only guard still permits the write", async () => {
    const { appendRun } = await import("../src/core/run-history.mjs");
    const { mkdtemp, writeFile, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = (await import("node:path")).default;

    // A run recorded before `basis` existed, exactly as it sits on disk today.
    const prior = {
      runId: "20260910T153418Z",
      startedAt: "2026-09-10T15:34:18.000Z",
      finishedAt: "2026-09-10T15:39:44.000Z",
      mode: "incremental",
      sources: [],
      tables: [
        { name: "properties", rows: 215806, inserted: 0, updated: 0, unchanged: 215806, removed: 0 },
      ],
      limitations: ["kept short for the fixture"],
      rootCid: "bafybeibshsx6h6xtbqb65at6oycndtpp3ufdou5i5unahulvtn46n4fr4m",
      manifestCid: "bafkreidpwpuddp5ri732aphkrqyz6cxkb6nmrzeshwxtdctzxscbzncjgq",
      carCid: "bafybeibshsx6h6xtbqb65at6oycndtpp3ufdou5i5unahulvtn46n4fr4m",
      ipnsName: "k51qzi5uqu5dgd1ekyyuhwggov571fjxof2p5ef4ke7enlq60k03r47fosb2un",
      resolvedCid: "bafybeibshsx6h6xtbqb65at6oycndtpp3ufdou5i5unahulvtn46n4fr4m",
      verifiedGateways: ["https://ipfs.filebase.io"],
      status: "succeeded",
    };
    const dir = await mkdtemp(path.join(tmpdir(), "run-history-"));
    const file = path.join(dir, "run-history.json");
    await writeFile(file, `${JSON.stringify({ schemaVersion: "elephant.run-history.v1", runs: [prior] }, null, 2)}\n`);

    // A new run carrying the field the older record has never heard of.
    const next = {
      ...prior,
      runId: "20260910T200608Z",
      tables: [
        { name: "properties", rows: 215806, basis: "row-hash", inserted: 0, updated: 0, unchanged: 215806, removed: 0 },
        { name: "permits", rows: 17671, basis: "row-count", previousRows: 17457, rowsDelta: 214 },
      ],
    };
    await expect(appendRun(file, next)).resolves.toBeDefined();

    const written = JSON.parse(await readFile(file, "utf8"));
    expect(written.runs).toHaveLength(2);
    // The prior run must come back exactly as it went in.
    expect(written.runs[1]).toEqual(prior);
  });
});
