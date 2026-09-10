import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { computeRawCid } from "../src/core/cid.mjs";
import {
  RUN_HISTORY_SCHEMA_VERSION,
  appendRun,
  computeTableDeltas,
  mergeRunHistories,
  mergeRunHistoryFile,
  readRunHistory,
  validateRunRecord,
} from "../src/core/run-history.mjs";

const temporaryDirectories = [];

/**
 * @returns {Promise<string>} path to a history file in a fresh scratch directory
 */
async function scratchHistoryPath() {
  const directory = await mkdtemp(path.join(tmpdir(), "oracle-run-history-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "runs", "run-history.json");
}

/**
 * @param {string} runId identifier for the run
 * @param {Record<string, unknown>} [overrides] fields to replace
 * @returns {Record<string, unknown>}
 */
function runRecord(runId, overrides = {}) {
  return {
    runId,
    startedAt: "2026-09-09T00:00:00.000Z",
    finishedAt: "2026-09-09T01:00:00.000Z",
    mode: "full",
    sources: [
      {
        name: "fl-dor-nal",
        url: "https://floridarevenue.com/property/Pages/DataPortal.aspx",
        window: "2026 preliminary roll",
        recordCount: 215806,
      },
      {
        name: "lake-cd-plus-permits",
        url: "https://services.arcgis.com/lake/permits/FeatureServer/0",
        window: null,
        recordCount: 17671,
      },
    ],
    tables: [
      {
        name: "properties",
        rows: 215806,
        inserted: 215806,
        updated: 0,
        unchanged: 0,
        removed: 0,
      },
    ],
    limitations: [
      "Permit detail pages return 403 from every egress, so contractor names are not published.",
    ],
    rootCid: computeRawCid(`${runId}-root`),
    manifestCid: computeRawCid(`${runId}-manifest`),
    carCid: computeRawCid(`${runId}-car`),
    ipnsName: "k51qzi5uqu5dgd1ekyyuhwggov571fjxof2p5ef4ke7enlq60k03r47fosb2un",
    resolvedCid: computeRawCid(`${runId}-root`),
    verifiedGateways: [
      "https://gateway.pinata.cloud",
      "https://gw.ipfs-lens.dev",
    ],
    status: "succeeded",
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("readRunHistory", () => {
  it("returns an empty history when nothing has been published yet", async () => {
    const historyPath = await scratchHistoryPath();
    expect(await readRunHistory(historyPath)).toEqual({
      schemaVersion: RUN_HISTORY_SCHEMA_VERSION,
      runs: [],
    });
  });

  it("refuses a corrupt history file", async () => {
    const historyPath = await scratchHistoryPath();
    await appendRun(historyPath, runRecord("run-0001"));
    await writeFile(
      historyPath,
      JSON.stringify({ schemaVersion: "elephant.run-history.v0", runs: [] }),
      "utf8",
    );
    await expect(readRunHistory(historyPath)).rejects.toThrow(
      /Invalid run history/,
    );
  });
});

describe("mergeRunHistories", () => {
  /**
   * @param {string[]} runIds run identifiers, in any order
   * @returns {{ schemaVersion: string, runs: Record<string, unknown>[] }}
   */
  const history = (runIds) => ({
    schemaVersion: RUN_HISTORY_SCHEMA_VERSION,
    runs: runIds.map((runId) => runRecord(runId)),
  });

  it("keeps every run either side recorded, newest first", () => {
    // A scheduled run appends to the checked-out copy and is then destroyed, so
    // the carried copy and the committed copy each hold runs the other does not.
    const merged = mergeRunHistories(
      history(["20260910T120000Z", "20260908T120000Z"]),
      history(["20260909T120000Z", "20260908T120000Z"]),
    );
    expect(merged.runs.map((run) => run.runId)).toEqual([
      "20260910T120000Z",
      "20260909T120000Z",
      "20260908T120000Z",
    ]);
  });

  it("refuses a run that differs between the two histories", () => {
    // Two records claiming the same run id are two claims about one immutable
    // publication. Silently picking one would be how a fabricated history looks.
    const left = history(["20260909T120000Z"]);
    const right = history(["20260909T120000Z"]);
    right.runs[0].status = "partial";
    expect(() => mergeRunHistories(left, right)).toThrow(
      /differs between them; a published run is immutable/,
    );
  });

  it("merges cleanly with an empty side", () => {
    const empty = { schemaVersion: RUN_HISTORY_SCHEMA_VERSION, runs: [] };
    expect(mergeRunHistories(empty, history(["20260909T120000Z"])).runs).toHaveLength(1);
    expect(mergeRunHistories(history(["20260909T120000Z"]), empty).runs).toHaveLength(1);
  });
});

describe("mergeRunHistoryFile", () => {
  it("writes the union back and leaves a later append working", async () => {
    const historyPath = await scratchHistoryPath();
    const carriedPath = `${historyPath}.carried`;
    await appendRun(historyPath, runRecord("20260908T120000Z"));
    await writeFile(
      carriedPath,
      JSON.stringify({
        schemaVersion: RUN_HISTORY_SCHEMA_VERSION,
        runs: [runRecord("20260909T120000Z")],
      }),
      "utf8",
    );

    const merged = await mergeRunHistoryFile(historyPath, carriedPath);
    expect(merged.runs.map((run) => run.runId)).toEqual([
      "20260909T120000Z",
      "20260908T120000Z",
    ]);

    // The point of merging before publishing: the run about to be appended lands
    // on top of a history that already knows about the carried runs.
    const after = await appendRun(historyPath, runRecord("20260910T120000Z"));
    expect(after.runs.map((run) => run.runId)).toEqual([
      "20260910T120000Z",
      "20260909T120000Z",
      "20260908T120000Z",
    ]);
  });

  it("treats a missing carried file as an empty history", async () => {
    const historyPath = await scratchHistoryPath();
    await appendRun(historyPath, runRecord("20260908T120000Z"));
    const merged = await mergeRunHistoryFile(historyPath, `${historyPath}.absent`);
    expect(merged.runs).toHaveLength(1);
  });
});

describe("appendRun", () => {
  it("writes the first run and keeps newest first", async () => {
    const historyPath = await scratchHistoryPath();
    const first = await appendRun(historyPath, runRecord("run-0001"));
    expect(first.schemaVersion).toBe("elephant.run-history.v1");
    expect(first.runs.map((run) => run.runId)).toEqual(["run-0001"]);

    const second = await appendRun(
      historyPath,
      runRecord("run-0002", {
        mode: "incremental",
        startedAt: "2026-09-10T00:00:00.000Z",
        finishedAt: "2026-09-10T00:20:00.000Z",
        tables: [
          {
            name: "properties",
            rows: 215812,
            inserted: 6,
            updated: 41,
            unchanged: 215765,
            removed: 0,
          },
        ],
      }),
    );
    expect(second.runs.map((run) => run.runId)).toEqual([
      "run-0002",
      "run-0001",
    ]);
    const onDisk = JSON.parse(await readFile(historyPath, "utf8"));
    expect(onDisk).toEqual(second);
  });

  it("retains prior CIDs byte for byte", async () => {
    const historyPath = await scratchHistoryPath();
    const original = runRecord("run-0001");
    await appendRun(historyPath, original);
    const after = await appendRun(
      historyPath,
      runRecord("run-0002", {
        startedAt: "2026-09-10T00:00:00.000Z",
        finishedAt: "2026-09-10T01:00:00.000Z",
      }),
    );
    expect(after.runs[1]).toEqual(validateRunRecord(original));
    expect(after.runs[1].rootCid).toBe(original.rootCid);
    expect(after.runs[1].manifestCid).toBe(original.manifestCid);
    expect(after.runs[1].carCid).toBe(original.carCid);
  });

  it("refuses a duplicate runId", async () => {
    const historyPath = await scratchHistoryPath();
    await appendRun(historyPath, runRecord("run-0001"));
    await expect(
      appendRun(
        historyPath,
        runRecord("run-0001", { rootCid: computeRawCid("rewritten") }),
      ),
    ).rejects.toThrow(/already recorded .*append-only/);
    const onDisk = await readRunHistory(historyPath);
    expect(onDisk.runs).toHaveLength(1);
    expect(onDisk.runs[0].rootCid).toBe(runRecord("run-0001").rootCid);
  });

  it("refuses to write when a prior run would be altered", async () => {
    const historyPath = await scratchHistoryPath();
    await appendRun(historyPath, runRecord("run-0001"));
    const stored = JSON.parse(await readFile(historyPath, "utf8"));
    // A stored value that validation would normalize is still a rewrite of a
    // published run, so appending on top of it has to fail closed.
    stored.runs[0].sources[0].name = "  fl-dor-nal  ";
    await writeFile(
      historyPath,
      `${JSON.stringify(stored, null, 2)}\n`,
      "utf8",
    );
    await expect(appendRun(historyPath, runRecord("run-0002"))).rejects.toThrow(
      /would alter a previously recorded run/,
    );
  });

  it("refuses malformed run records", async () => {
    const historyPath = await scratchHistoryPath();
    await expect(
      appendRun(historyPath, runRecord("run-0001", { mode: "delta" })),
    ).rejects.toThrow(/mode/);
    await expect(
      appendRun(
        historyPath,
        runRecord("run-0001", {
          rootCid: "QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco",
        }),
      ),
    ).rejects.toThrow(/rootCid: must be a CIDv1 base32 string/);
    await expect(
      appendRun(historyPath, runRecord("run-0001", { status: "green" })),
    ).rejects.toThrow(/status/);
    await expect(
      appendRun(historyPath, { ...runRecord("run-0001"), extra: true }),
    ).rejects.toThrow(/Invalid run record/);
    await expect(
      appendRun(
        historyPath,
        runRecord("run-0001", { finishedAt: "2026-09-08T00:00:00.000Z" }),
      ),
    ).rejects.toThrow(/finishedAt must not precede startedAt/);
    expect(await readRunHistory(historyPath)).toEqual({
      schemaVersion: RUN_HISTORY_SCHEMA_VERSION,
      runs: [],
    });
  });

  it("accepts a run that could not be verified, so failures stay on record", async () => {
    const historyPath = await scratchHistoryPath();
    const history = await appendRun(
      historyPath,
      runRecord("run-0003", {
        status: "partial",
        ipnsName: null,
        resolvedCid: null,
        verifiedGateways: [],
        limitations: ["ipfs.io and dweb.link returned 429 from this egress."],
      }),
    );
    expect(history.runs[0].status).toBe("partial");
    expect(history.runs[0].verifiedGateways).toEqual([]);
  });
});

describe("computeTableDeltas", () => {
  it("counts inserts, updates, unchanged rows and removals", () => {
    expect(
      computeTableDeltas(
        { a: "h1", b: "h2", c: "h3" },
        { a: "h1", b: "h2-changed", d: "h4" },
      ),
    ).toEqual({ inserted: 1, updated: 1, unchanged: 1, removed: 1 });
  });

  it("accepts Map inputs", () => {
    expect(
      computeTableDeltas(
        new Map([
          ["a", "h1"],
          ["b", "h2"],
        ]),
        new Map([
          ["a", "h1"],
          ["b", "h2"],
        ]),
      ),
    ).toEqual({ inserted: 0, updated: 0, unchanged: 2, removed: 0 });
  });

  it("treats a first run as all inserts and an emptied table as all removals", () => {
    expect(computeTableDeltas({}, { a: "h1", b: "h2" })).toEqual({
      inserted: 2,
      updated: 0,
      unchanged: 0,
      removed: 0,
    });
    expect(computeTableDeltas({ a: "h1", b: "h2" }, {})).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 0,
      removed: 2,
    });
    expect(computeTableDeltas(null, null)).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 0,
      removed: 0,
    });
  });

  it("refuses inputs that are not key -> rowHash maps", () => {
    expect(() => computeTableDeltas(["a"], {})).toThrow(/previousRows/);
    expect(() => computeTableDeltas({}, ["a"])).toThrow(/currentRows/);
  });
});
