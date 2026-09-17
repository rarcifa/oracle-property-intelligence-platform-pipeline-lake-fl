/** Bundle metadata must describe the explicit bytes, not a previous release. */
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { createContext } from "../src/context.js";
import type { OracleDataStore } from "../src/data/duckdb.js";
import { readServedMetadata, type ArtifactVerification } from "../src/data/run.js";
import { callTool } from "../src/mcp/tools.js";

const OLD = "bafybeif5vpiyp2v5foc7k3swsgoujzlvo7exaspntdsrmc4tp5vkuok67q";
const NEW = "bafybeigakr7d6nywkbanzmh4r7cpv7kz7qs5vxvwlxcxuovk2lobrj442u";
const RUN = "20260916T181000Z";
const directories: string[] = [];

interface TestLedger {
  schemaVersion: string;
  attempts: Record<
    string,
    {
      attemptId: string;
      target: { runId: string; rootCid: string };
      state: string;
      transitions: {
        sequence: number;
        stage: string;
        at: string;
        receipt: Record<string, unknown>;
      }[];
    }
  >;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(
  options: { latestRoot?: string; coverageRun?: string; runId?: string } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "oracle-served-metadata-"));
  directories.push(dir);
  const source = `https://ipfs.filebase.io/ipfs/${NEW}/query-table.parquet`;
  const latestPath = join(dir, "latest.json");
  const latest = {
    runId: RUN,
    rootCid: options.latestRoot ?? OLD,
    manifestCid: "old-manifest-cid",
    archiveCid: "old-archive-cid",
    resolvedCid: options.latestRoot ?? OLD,
  };
  const coverage = {
    runId: options.coverageRun ?? "20260910T225242Z",
    tables: { properties: { rows: 1, source: "synthetic-property-source" } },
    limitations: ["Synthetic coverage caveat"],
  };
  await Promise.all([
    writeFile(latestPath, JSON.stringify(latest)),
    writeFile(join(dir, "coverage.json"), JSON.stringify(coverage)),
    writeFile(
      join(dir, `verification-${RUN}.json`),
      JSON.stringify({ runId: RUN, rootCid: options.latestRoot ?? OLD, verifications: [] }),
    ),
  ]);
  const config = loadConfig({
    ORACLE_RUN_DIR: dir,
    ORACLE_PARQUET_URL: source,
    ORACLE_LATEST_PATH: latestPath,
    ORACLE_DATA_RUN_ID: options.runId ?? RUN,
    ORACLE_DATA_ROOT_CID: NEW,
  });
  const store = {
    source,
    activeSource: source,
    sourceKind: "ipfs",
    sourceObservationsOnly: true,
    queryOne: vi.fn(async () => ({ properties: 1, permit_records: 0 })),
    query: vi.fn(async () => []),
  } as unknown as OracleDataStore;
  const context = createContext(config, store);
  return { config, context, latest, store, dir };
}

async function publicationFixture(inventoryName = "submission-gateway-inventory-20260917.json") {
  const result = await fixture();
  for (const name of [
    `manifest-${RUN}.json`,
    "public-gateway-readback-20260917T135241Z.json",
    "public-gateway-archive-readback-20260917T151703Z.json",
  ]) {
    await copyFile(join(REPO_ROOT, "artifacts", name), join(result.dir, name));
  }
  await copyFile(
    join(REPO_ROOT, "artifacts", "submission-gateway-inventory-20260917.json"),
    join(result.dir, inventoryName),
  );
  return { ...result, inventoryPath: join(result.dir, inventoryName) };
}

/** Protocol-shaped local test transitions are not a real publication certificate. */
async function finalizedFixture() {
  const result = await publicationFixture();
  const inventory = JSON.parse(await readFile(result.inventoryPath, "utf8"));
  const manifestBytes = await readFile(join(result.dir, `manifest-${RUN}.json`));
  const observed: TestLedger = JSON.parse(
    await readFile(join(REPO_ROOT, "artifacts/publication-attempts.json"), "utf8"),
  );
  const attempt = structuredClone(
    Object.values(observed.attempts).find(
      (value) =>
        value.target.runId === RUN &&
        value.target.rootCid === NEW &&
        value.transitions.some((transition) => transition.stage === "SECONDARY_PIN_RECORDED"),
    ),
  );
  if (!attempt) throw new Error("Missing recorded secondary-retention fixture");
  const artifacts = [];
  for (const artifact of inventory.artifacts) {
    const receipt: {
      listedArtifacts?: { artifacts: ArtifactVerification[] };
      verification: Omit<ArtifactVerification, "name">;
    } = JSON.parse(
      await readFile(join(result.dir, artifact.receipt.slice("artifacts/".length)), "utf8"),
    );
    artifacts.push(
      receipt.listedArtifacts?.artifacts.find((entry) => entry.name === artifact.name) ?? {
        name: artifact.name,
        ...receipt.verification,
      },
    );
  }
  const verification = {
    checkedArtifacts: artifacts.length + 1,
    verifiedArtifacts: artifacts.length + 1,
    minimumIndependentGateways: 2,
    artifacts: [{ name: "manifest.json", ...inventory.manifestSelfProof }, ...artifacts],
  };
  const report = {
    runId: RUN,
    rootCid: NEW,
    manifestCid: inventory.manifestSelfProof.cid,
    manifestDigest: `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`,
    verification,
  };
  attempt.transitions = attempt.transitions.slice(0, 7);
  for (const stage of [
    "VERIFIED",
    "HISTORY_RECORDED",
    "IPNS_REPOINT_RECORDED",
    "IPNS_VERIFIED",
    "APPROVAL_CONSUMED",
    "FINALIZED",
  ]) {
    attempt.transitions.push({
      sequence: attempt.transitions.length + 1,
      stage,
      at: "2026-09-17T17:20:00.000Z",
      receipt:
        stage === "VERIFIED" ? verification : { rootCid: NEW, fixture: "SYNTHETIC_TERMINAL_STAGE" },
    });
  }
  attempt.state = "FINALIZED";
  const ledger = {
    schemaVersion: observed.schemaVersion,
    attempts: { [attempt.attemptId]: attempt },
  };
  const ledgerPath = join(result.dir, "publication-attempts.json");
  const reportPath = join(result.dir, `verification-${RUN}.json`);
  await Promise.all([
    writeFile(ledgerPath, JSON.stringify(ledger)),
    writeFile(reportPath, JSON.stringify(report)),
    rm(result.inventoryPath),
  ]);
  return { ...result, ledgerPath, reportPath };
}

describe("served run metadata", () => {
  it("does not reuse an older manifest or verification with a matching run ID", async () => {
    const { config } = await fixture({ coverageRun: RUN });
    const metadata = await readServedMetadata(config, { runId: RUN, rootCid: NEW });
    expect(metadata.latest).toBeNull();
    expect(metadata.verification).toBeNull();
    expect(metadata.coverage?.runId).toBe(RUN);
  });

  it("accepts bundle metadata only when both served run and root match", async () => {
    const { config, latest } = await fixture({ latestRoot: NEW, coverageRun: RUN });
    expect(await readServedMetadata(config, { runId: RUN, rootCid: NEW })).toMatchObject({
      latest,
      coverage: { runId: RUN },
      verification: { runId: RUN, rootCid: NEW },
    });
    expect(await readServedMetadata(config, { runId: "other-run", rootCid: NEW })).toEqual({
      latest: null,
      coverage: null,
      verification: null,
      publicationEvidence: null,
    });
  });

  it("keeps local or unidentified bytes free of unrelated public proof", async () => {
    const { config } = await fixture({ latestRoot: NEW, coverageRun: RUN });
    expect(await readServedMetadata(config, { runId: RUN, rootCid: null })).toMatchObject({
      latest: null,
      verification: null,
    });
    expect(await readServedMetadata(config, { runId: null, rootCid: NEW })).toEqual({
      latest: null,
      coverage: null,
      verification: null,
      publicationEvidence: null,
    });
  });

  it("serves the same explicit partial identity through REST and MCP", async () => {
    const { context } = await fixture();
    const response = await createApp(context).handle({
      method: "GET",
      path: "/api/meta/run",
      query: new URLSearchParams(),
      headers: {},
    });
    const rest = JSON.parse(String(response.body));
    const mcp = (await callTool(context, "getOracleDatasetInfo", {})).payload;
    expect(rest.run).toEqual({ runId: RUN, rootCid: NEW });
    expect(rest.coverage).toBeNull();
    expect(rest.verification).toBeNull();
    expect(rest).toMatchObject({
      sourceObservationsOnly: true,
      countyComplete: false,
      currentPermitStatusAccepted: false,
    });
    expect(mcp).toMatchObject({
      run: rest.run,
      runId: RUN,
      sourceObservationsOnly: true,
      countyComplete: false,
      currentPermitStatusAccepted: false,
      coverageTables: null,
      provenance: { runId: RUN, rootCid: NEW, sourceObservationsOnly: true },
    });
  });

  it("does not borrow a run ID from latest for a different explicit public root", async () => {
    const { config, store } = await fixture();
    const context = createContext({ ...config, dataRunId: null, dataRootCid: null }, store);
    expect(await context.provenance()).toMatchObject({ runId: null, rootCid: NEW });
  });

  it("can identify explicit public bytes from a matching bundled root", async () => {
    const { config, store } = await fixture({ latestRoot: NEW });
    const context = createContext({ ...config, dataRunId: null, dataRootCid: null }, store);
    expect(await context.provenance()).toMatchObject({ runId: RUN, rootCid: NEW });
  });

  it("does not let an initially empty IPNS configuration donate old local coverage", async () => {
    const { config, store } = await fixture();
    const context = createContext(
      { ...config, parquetSource: "", parquetSourceKind: "local", dataRunId: null },
      store,
    );
    expect(await context.provenance()).toMatchObject({ runId: null, rootCid: NEW });
  });

  it("keeps the MCP publication object null for local unpublished bytes", async () => {
    const { config, store } = await fixture();
    const localStore = {
      ...store,
      source: "/synthetic/query-table.parquet",
      activeSource: "/synthetic/query-table.parquet",
      sourceKind: "local",
    } as unknown as OracleDataStore;
    const context = createContext(
      { ...config, parquetSourceKind: "local", dataRootCid: null },
      localStore,
    );
    const result = await callTool(context, "getOracleDatasetInfo", {});
    expect(result.payload).toMatchObject({
      run: null,
      runId: RUN,
      provenance: { runId: RUN, rootCid: null, dataSourceKind: "local" },
    });
  });
});

describe("selected-run standalone publication evidence", () => {
  it("binds manifest, CAR and every receipt without making the run latest or retained", async () => {
    const { config } = await publicationFixture();
    const metadata = await readServedMetadata(config, { runId: RUN, rootCid: NEW });
    expect(metadata.latest).toBeNull();
    expect(metadata.publicationEvidence).toMatchObject({
      runId: RUN,
      rootCid: NEW,
      manifestCid: "bafkreiezsu6lbe7v43vv5hq26tp2ucojuajvpntapw2rn6fhntuq3oyopm",
      manifestBytes: 11417,
      carBytes: 341012658,
      artifactCount: 40,
      verifiedGateways: ["https://ipfs.filebase.io", "https://gateway.pinata.cloud"],
      retentionVerified: false,
      publicationPromoted: false,
    });
    expect(metadata.verification?.verifications).toHaveLength(41);
    expect(metadata.verification?.verifications.every((entry) => entry.verified)).toBe(true);
  });

  it("exposes separate evidence through REST while retaining source-only holds", async () => {
    const { context } = await publicationFixture();
    const response = await createApp(context).handle({
      method: "GET",
      path: "/api/meta/run",
      query: new URLSearchParams(),
      headers: {},
    });
    const body = JSON.parse(String(response.body));
    expect(body).toMatchObject({
      run: { runId: RUN, rootCid: NEW },
      publicationEvidence: { retentionVerified: false, publicationPromoted: false },
      sourceObservationsOnly: true,
      countyComplete: false,
      currentPermitStatusAccepted: false,
    });
    expect(body.run.manifestCid).toBeUndefined();
    expect(body.run.ipnsName).toBeUndefined();
  });

  it("discovers inventories generically instead of depending on a frozen inventory date", async () => {
    const { config } = await publicationFixture(`submission-gateway-inventory-${RUN}.json`);
    expect(
      (await readServedMetadata(config, { runId: RUN, rootCid: NEW })).publicationEvidence,
    ).toMatchObject({ runId: RUN, artifactCount: 40 });
  });

  it("does not let a held later run or a different root inherit this proof", async () => {
    const { config } = await publicationFixture();
    for (const identity of [
      { runId: "20260917T152549Z", rootCid: NEW },
      { runId: RUN, rootCid: OLD },
      { runId: RUN, rootCid: null },
    ]) {
      expect((await readServedMetadata(config, identity)).publicationEvidence).toBeNull();
    }
  });

  it("rejects even parseable manifest bytes when their digest differs", async () => {
    const { config, dir } = await publicationFixture();
    const path = join(dir, `manifest-${RUN}.json`);
    await writeFile(path, `${await readFile(path, "utf8")} `);
    const metadata = await readServedMetadata(config, { runId: RUN, rootCid: NEW });
    expect(metadata.publicationEvidence).toBeNull();
    expect(metadata.verification).toBeNull();
  });

  it("rejects an inventory whose claimed object identity does not match the manifest", async () => {
    const { config, inventoryPath } = await publicationFixture();
    const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
    inventory.artifacts[0].cid = OLD;
    await writeFile(inventoryPath, JSON.stringify(inventory));
    expect(
      (await readServedMetadata(config, { runId: RUN, rootCid: NEW })).publicationEvidence,
    ).toBeNull();
  });

  it("rejects a cross-run inventory even when its manifest digest and objects match", async () => {
    const { config, inventoryPath } = await publicationFixture();
    const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
    inventory.runId = "20260917T152549Z";
    await writeFile(inventoryPath, JSON.stringify(inventory));
    expect(
      (await readServedMetadata(config, { runId: RUN, rootCid: NEW })).publicationEvidence,
    ).toBeNull();
  });

  it("does not count two results from the same gateway hostname as independent", async () => {
    const { config, inventoryPath } = await publicationFixture();
    const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
    inventory.manifestSelfProof.results[1] = { ...inventory.manifestSelfProof.results[0] };
    await writeFile(inventoryPath, JSON.stringify(inventory));
    expect(
      (await readServedMetadata(config, { runId: RUN, rootCid: NEW })).publicationEvidence,
    ).toBeNull();
  });

  it("requires raw receipt byte matches rather than trusting an inventory success flag", async () => {
    const { config, dir } = await publicationFixture();
    const path = join(dir, "public-gateway-readback-20260917T135241Z.json");
    const receipt = JSON.parse(await readFile(path, "utf8"));
    receipt.listedArtifacts.artifacts[0].results[1].bytes += 1;
    await writeFile(path, JSON.stringify(receipt));
    expect(
      (await readServedMetadata(config, { runId: RUN, rootCid: NEW })).publicationEvidence,
    ).toBeNull();
  });

  it("rejects an archive receipt bound to another run", async () => {
    const { config, dir } = await publicationFixture();
    const path = join(dir, "public-gateway-archive-readback-20260917T151703Z.json");
    const receipt = JSON.parse(await readFile(path, "utf8"));
    receipt.runId = "OTHER_RUN";
    await writeFile(path, JSON.stringify(receipt));
    expect(
      (await readServedMetadata(config, { runId: RUN, rootCid: NEW })).publicationEvidence,
    ).toBeNull();
  });
});

describe("selected-run finalized publication receipts", () => {
  it("binds the frozen real finalized production packet independently of future latest movement", async () => {
    const { config, context, dir } = await fixture();
    const frozen: {
      schemaVersion: string;
      runId: string;
      rootCid: string;
      files: Record<string, { sourcePath: string; bytes: number; sha256: string; utf8: string }>;
    } = JSON.parse(
      await readFile(
        new URL("./fixtures/finalized-publication-20260916T181000Z.json", import.meta.url),
        "utf8",
      ),
    );
    expect(frozen).toMatchObject({
      schemaVersion: "oracle.frozen-finalized-reader-fixture.v1",
      runId: RUN,
      rootCid: NEW,
    });
    const names = [
      "latest.json",
      "publication-attempts.json",
      `manifest-${RUN}.json`,
      `verification-${RUN}.json`,
    ];
    expect(Object.keys(frozen.files).sort()).toEqual(names.sort());
    for (const name of names) {
      const file = frozen.files[name]!;
      expect(file.sourcePath).toBe(`artifacts/${name}`);
      expect(Buffer.byteLength(file.utf8)).toBe(file.bytes);
      expect(`sha256:${createHash("sha256").update(file.utf8).digest("hex")}`).toBe(file.sha256);
      await writeFile(join(dir, name), file.utf8);
    }
    const metadata = await readServedMetadata(config, { runId: RUN, rootCid: NEW });
    expect(metadata.latest).toMatchObject({
      runId: RUN,
      rootCid: NEW,
      candidateCommit: "4fc47a475bd01d483b81150b741914eec2f8bc32",
    });
    expect(metadata.publicationEvidence).toMatchObject({
      runId: RUN,
      rootCid: NEW,
      scope: "finalized-publication-receipt",
      manifestCid: "bafkreiezsu6lbe7v43vv5hq26tp2ucojuajvpntapw2rn6fhntuq3oyopm",
      manifestBytes: 11417,
      manifestSha256: "sha256:99953cb093f5e6eb5e9e1af4dfaa09c9a01357b6607db516f8a76ce90dbb0e7b",
      carCid: "bafybeicasgbg4y75477jq73lm7rsiw4a6gcbz4yjxdy6dicv5aj2q5oriq",
      carBytes: 341012658,
      carSha256: "sha256:b09b1186e3111258300e0fef1ed5b721f99234e7b81df155454009b4bf4c659f",
      retentionVerified: true,
      publicationPromoted: true,
    });
    expect(metadata.verification?.verifications).toHaveLength(41);
    expect(
      metadata.verification?.verifications.every(
        (entry) => entry.verified && entry.matchedGateways.length >= 2,
      ),
    ).toBe(true);
    const response = await createApp(context).handle({
      method: "GET",
      path: "/api/meta/run",
      query: new URLSearchParams(),
      headers: {},
    });
    expect(JSON.parse(String(response.body))).toMatchObject({
      publicationEvidence: { scope: "finalized-publication-receipt", retentionVerified: true },
      sourceObservationsOnly: true,
      countyComplete: false,
      currentPermitStatusAccepted: false,
    });
    // Changing the selected pointer never removes this old immutable run's own receipts.
    await writeFile(
      join(dir, "latest.json"),
      JSON.stringify({ runId: "UNIT_LATER_POINTER", rootCid: OLD }),
    );
    const old = await readServedMetadata(config, { runId: RUN, rootCid: NEW });
    expect(old.latest).toBeNull();
    expect(old.publicationEvidence).toEqual(metadata.publicationEvidence);
  });

  it("normalizes every nested gateway proof and binds actual secondary receipts without borrowing latest", async () => {
    const { config } = await finalizedFixture();
    const metadata = await readServedMetadata(config, { runId: RUN, rootCid: NEW });
    expect(metadata.latest).toBeNull();
    expect(metadata.publicationEvidence).toMatchObject({
      runId: RUN,
      rootCid: NEW,
      scope: "finalized-publication-receipt",
      manifestBytes: 11417,
      carBytes: 341012658,
      retentionVerified: true,
      publicationPromoted: true,
    });
    expect(metadata.verification?.verifications).toHaveLength(41);
  });

  it("rejects cross-root finalized receipts", async () => {
    const { config, ledgerPath } = await finalizedFixture();
    const ledger: TestLedger = JSON.parse(await readFile(ledgerPath, "utf8"));
    Object.values(ledger.attempts).forEach((attempt) => {
      attempt.target.rootCid = OLD;
    });
    await writeFile(ledgerPath, JSON.stringify(ledger));
    expect(
      (await readServedMetadata(config, { runId: RUN, rootCid: NEW })).publicationEvidence,
    ).toBeNull();
  });

  it("does not invent retention when the independently verified archive is absent", async () => {
    const { config, ledgerPath } = await finalizedFixture();
    const ledger: TestLedger = JSON.parse(await readFile(ledgerPath, "utf8"));
    Object.values(ledger.attempts).forEach((attempt) => {
      delete attempt.transitions.find(
        (transition) => transition.stage === "SECONDARY_PIN_RECORDED",
      )!.receipt.archive;
    });
    await writeFile(ledgerPath, JSON.stringify(ledger));
    expect(
      (await readServedMetadata(config, { runId: RUN, rootCid: NEW })).publicationEvidence,
    ).toBeNull();
  });

  it("rejects incomplete or altered normal gateway reports", async () => {
    const { config, reportPath } = await finalizedFixture();
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    report.verification.artifacts[1].results[1].bytes += 1;
    await writeFile(reportPath, JSON.stringify(report));
    expect(
      (await readServedMetadata(config, { runId: RUN, rootCid: NEW })).publicationEvidence,
    ).toBeNull();
  });

  it("keeps pre-finalized nested reports out of legacy verification and retention views", async () => {
    const { config, ledgerPath } = await finalizedFixture();
    const ledger: TestLedger = JSON.parse(await readFile(ledgerPath, "utf8"));
    for (const attempt of Object.values(ledger.attempts)) {
      attempt.state = "APPROVAL_CONSUMED";
      attempt.transitions.pop();
    }
    await writeFile(ledgerPath, JSON.stringify(ledger));
    expect(await readServedMetadata(config, { runId: RUN, rootCid: NEW })).toMatchObject({
      publicationEvidence: null,
      verification: null,
    });
  });

  it("rejects a retained archive whose byte digest no longer matches the manifest", async () => {
    const { config, ledgerPath } = await finalizedFixture();
    const ledger: TestLedger = JSON.parse(await readFile(ledgerPath, "utf8"));
    for (const attempt of Object.values(ledger.attempts)) {
      const receipt = attempt.transitions[6]!.receipt as {
        archive: { publicGateway: { sha256: string } };
      };
      receipt.archive.publicGateway.sha256 = `sha256:${"0".repeat(64)}`;
    }
    await writeFile(ledgerPath, JSON.stringify(ledger));
    expect(
      (await readServedMetadata(config, { runId: RUN, rootCid: NEW })).publicationEvidence,
    ).toBeNull();
  });
});
