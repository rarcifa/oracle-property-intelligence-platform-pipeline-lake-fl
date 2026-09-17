/** Actual hosted partial-data walkthrough. This is NOT the strict passed full demo. */
import { chromium } from "@playwright/test";
import { Buffer } from "node:buffer";
import { mkdir, writeFile, readFile, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import path from "node:path";
import { URL } from "node:url";
import { EXPECTED_MCP_TOOLS } from "./demo-contract.mjs";
import { assertPaintSample, startPaintMonitor } from "./record-preview-paint.mjs";
import { assertHistoricalRowsDisplayed, historicalRowCells } from "./record-preview-historical.mjs";
import { validateArtifactManifest } from "../../../pipeline/src/core/artifact-manifest.mjs";
import {
  buildUnixfsDirectory,
  computeRawCid,
  isCidV1Base32,
} from "../../../pipeline/src/core/cid.mjs";
import { verifyArtifactAcrossGateways } from "../../../pipeline/src/core/gateway-verify.mjs";

const digest = (value) => {
  const normalized = typeof value === "string" ? value.replace(/^sha256:/, "") : "";
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error("Missing valid publication SHA-256");
  return `sha256:${normalized}`;
};
const publicGateways = (values, hostedBase) => {
  const gateways = new Map();
  for (const value of values ?? []) {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.hostname === new URL(hostedBase).hostname
    )
      throw new Error("Publication gateway must be an independent public HTTPS origin");
    gateways.set(url.hostname.toLowerCase(), url.origin);
  }
  if (gateways.size < 2) throw new Error("Two independent recorded public gateways are required");
  return [...gateways.values()];
};
function proofBinding(proof, hostedBase, expected = null) {
  if (!proof?.verified || !isCidV1Base32(proof.cid))
    throw new Error("Missing verified CID-addressed publication proof");
  const first = proof.results?.find(
    (result) => result.ok && result.status === 200 && result.error === null,
  );
  const bytes = expected?.bytes ?? first?.bytes;
  const sha256 = digest(expected?.sha256 ?? first?.sha256);
  if (!Number.isSafeInteger(bytes) || bytes <= 0)
    throw new Error("Missing exact publication byte size");
  const minimum = Math.max(2, proof.minimumIndependentGateways ?? 2);
  const matching = (proof.results ?? []).filter((result) => {
    const matched =
      result.ok &&
      result.status === 200 &&
      result.error === null &&
      result.bytes === bytes &&
      result.sha256 === sha256 &&
      proof.matchedGateways?.includes(result.gateway);
    if (!matched || result.responseUrl === undefined) return matched;
    try {
      const response = new URL(result.responseUrl);
      return (
        response.origin === new URL(result.gateway).origin &&
        response.pathname === `/ipfs/${proof.cid}`
      );
    } catch {
      return false;
    }
  });
  const gateways = publicGateways(
    matching.map((result) => result.gateway),
    hostedBase,
  );
  if (gateways.length < minimum) throw new Error("Recorded publication byte proofs disagree");
  return { cid: proof.cid, bytes, sha256, gateways };
}
function bindSelectedPublication(meta, selectedRun, selectedRoot, hostedBase) {
  if (meta.run?.runId !== selectedRun || meta.run?.rootCid !== selectedRoot)
    throw new Error("Selected publication identity differs from the hosted snapshot");
  const evidence = meta.publicationEvidence;
  if (evidence && (evidence.runId !== selectedRun || evidence.rootCid !== selectedRoot))
    throw new Error("Publication evidence belongs to a different snapshot");
  if (
    evidence &&
    (!isCidV1Base32(evidence.manifestCid) ||
      !isCidV1Base32(evidence.carCid) ||
      !Number.isSafeInteger(evidence.manifestBytes) ||
      evidence.manifestBytes <= 0 ||
      !Number.isSafeInteger(evidence.carBytes) ||
      evidence.carBytes <= 0 ||
      typeof evidence.retentionVerified !== "boolean" ||
      typeof evidence.publicationPromoted !== "boolean")
  )
    throw new Error("Selected publication evidence has incomplete CID/size/status fields");
  const manifestCid = evidence?.manifestCid ?? meta.run.manifestCid;
  const verification = meta.verification;
  if (
    !isCidV1Base32(manifestCid) ||
    verification?.runId !== selectedRun ||
    verification?.rootCid !== selectedRoot ||
    (evidence && meta.run.manifestCid && meta.run.manifestCid !== manifestCid) ||
    (evidence && meta.run.carCid && meta.run.carCid !== evidence.carCid)
  )
    throw new Error("Selected manifest pointer lacks exact-run/root publication verification");
  const manifest = proofBinding(
    verification.verifications?.find((entry) => entry.cid === manifestCid),
    hostedBase,
    evidence ? { bytes: evidence.manifestBytes, sha256: evidence.manifestSha256 } : null,
  );
  const carCid = evidence?.carCid ?? meta.run.carCid;
  if (!isCidV1Base32(carCid)) throw new Error("Selected publication has no delivered CAR pointer");
  const car = proofBinding(
    verification.verifications?.find((entry) => entry.cid === carCid),
    hostedBase,
    evidence ? { bytes: evidence.carBytes, sha256: evidence.carSha256 } : null,
  );
  return {
    runId: selectedRun,
    rootCid: selectedRoot,
    binding: evidence ? "exact-run-publication-evidence" : "verified-published-run-pointer",
    manifest,
    car,
    artifactCount: evidence?.artifactCount ?? null,
    retentionVerified: evidence?.retentionVerified ?? null,
    publicationPromoted: evidence?.publicationPromoted ?? null,
    publishedRunPointerMatched:
      meta.run.manifestCid === manifestCid && meta.run.resolvedCid === selectedRoot,
    recordedAt: evidence?.recordedAt ?? null,
  };
}
function incrementalHistoryPair(meta, publication) {
  const runs = meta.runHistory?.runs ?? [];
  const current = runs.find(
    (run) =>
      run.runId === publication.runId &&
      run.rootCid === publication.rootCid &&
      run.manifestCid === publication.manifest.cid,
  );
  if (
    current?.status !== "succeeded" ||
    current.mode !== "incremental" ||
    !current.tables?.some(
      (table) =>
        table.inserted > 0 ||
        table.updated > 0 ||
        table.removed > 0 ||
        (table.rowsDelta !== 0 && Number.isInteger(table.rowsDelta)),
    )
  )
    return null;
  const prior = runs
    .filter(
      (run) =>
        run.status === "succeeded" &&
        run.runId !== current.runId &&
        isCidV1Base32(run.rootCid) &&
        isCidV1Base32(run.manifestCid) &&
        run.rootCid !== current.rootCid &&
        run.manifestCid !== current.manifestCid &&
        Number.isFinite(Date.parse(run.finishedAt)) &&
        Date.parse(run.finishedAt) < Date.parse(current.finishedAt),
    )
    .sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt))[0];
  return prior ? { current, prior } : null;
}
async function fetchPublicManifest(
  binding,
  expectedRun,
  expectedRoot,
  fetchImpl = globalThis.fetch,
) {
  const checks = [];
  let manifest;
  for (const gateway of binding.gateways.slice(0, 2)) {
    const locator = `${gateway}/ipfs/${binding.cid}`;
    const response = await fetchImpl(locator, {
      signal: globalThis.AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error(`Manifest public retrieval HTTP ${response.status}`);
    if (response.url && new URL(response.url).hostname !== new URL(gateway).hostname)
      throw new Error("Manifest gateways redirected to an unverified origin");
    const bytes = Buffer.from(await response.arrayBuffer());
    const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (
      computeRawCid(bytes) !== binding.cid ||
      (binding.bytes !== undefined && bytes.length !== binding.bytes) ||
      (binding.sha256 !== undefined && sha256 !== binding.sha256) ||
      (checks.length > 0 && (bytes.length !== checks[0].bytes || sha256 !== checks[0].sha256))
    )
      throw new Error("Public manifest bytes differ from the selected immutable CID/size/digest");
    manifest = validateArtifactManifest(JSON.parse(bytes.toString("utf8")));
    if (manifest.runId !== expectedRun || manifest.root.cid !== expectedRoot)
      throw new Error("Public manifest names a different selected run/root");
    checks.push({ gateway, cid: binding.cid, bytes: bytes.length, sha256 });
  }
  if (checks.length !== 2) throw new Error("Two actual public manifest retrievals are required");
  return { manifest, checks };
}
function validateSelectedCar(manifest, publication) {
  const artifact = manifest.artifacts.find((entry) => entry.cid === publication.car.cid);
  if (
    artifact?.codec !== "file" ||
    artifact.size !== publication.car.bytes ||
    artifact.sha256 !== publication.car.sha256 ||
    manifest.root.car !== `ipfs://${artifact.cid}` ||
    !manifest.directoryCars?.some(
      (entry) => entry.directoryCid === publication.rootCid && entry.carCid === artifact.cid,
    ) ||
    (publication.artifactCount !== null && publication.artifactCount !== manifest.artifacts.length)
  )
    throw new Error("Selected CAR metadata differs from the public manifest's delivered archive");
  return artifact;
}

function validateOverviewFields(fields, publication, hasEvidence, text) {
  if (
    fields.rootCid !== publication.rootCid ||
    fields.manifestCid !== publication.manifest.cid ||
    fields.carCid !== publication.car.cid ||
    (hasEvidence &&
      (fields.manifestSha256 !== publication.manifest.sha256 ||
        fields.carSha256 !== publication.car.sha256 ||
        fields.carSize !== `${new Intl.NumberFormat("en-US").format(publication.car.bytes)} bytes`))
  )
    throw new Error("Actual Overview manifest/CAR values differ from selected metadata");
  const unverified = text
    .replace(/\s+/g, " ")
    .toLowerCase()
    .includes("independent retention remains unverified");
  if (
    (publication.retentionVerified === false && !unverified) ||
    (publication.retentionVerified === true && unverified)
  )
    throw new Error("Actual Overview retention status contradicts selected metadata");
}

/** Pure/mocked self-tests: no browser launch, hosted calls, or repository writes. */
async function selfTest() {
  // Synthetic pixel counts only: no browser launch or claimed runtime evidence.
  assertPaintSample({ pixels: 1000000, darkPixels: 995000, brightPixels: 1000 });
  assert.throws(() => assertPaintSample({ pixels: 1000000, darkPixels: 1000000, brightPixels: 0 }));
  assert.throws(() => assertPaintSample({ pixels: 0, darkPixels: 0, brightPixels: 0 }));
  assert.throws(() => assertPaintSample({ pixels: 100, darkPixels: 100, brightPixels: -1 }));
  assert.deepEqual(
    historicalRowCells({
      permit_number: "SYNTHETIC-PERMIT-ONLY",
      jurisdiction: "synthetic jurisdiction",
      permit_status: "ISSUED",
      issued_date: "raw source date only",
      permit_type: "ROOF/REROOF",
      contractor_name: "synthetic source-listed name",
    }),
    [
      "SYNTHETIC-PERMIT-ONLY synthetic jurisdiction",
      "ISSUED raw source date only",
      "ROOF/REROOF",
      "—",
      "synthetic source-listed name BBB: unknown",
    ],
  );
  const hosted = "https://preview.example.invalid";
  const gateways = ["https://ipfs.filebase.io", "https://gateway.pinata.cloud"];
  const queryBytes = Buffer.from("synthetic query bytes for recorder contract tests only");
  const queryCid = computeRawCid(queryBytes);
  const root = buildUnixfsDirectory([
    { name: "query-table.parquet", cid: queryCid, size: queryBytes.length },
  ]);
  const carBytes = Buffer.from("synthetic CAR metadata fixture; not a publication");
  const carCid = computeRawCid(carBytes);
  const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const run = "synthetic-preview-fixture";
  const manifest = {
    schemaVersion: "elephant.artifact-manifest.v1",
    runId: run,
    county: "lake",
    generatedAt: "2026-09-17T12:00:00.000Z",
    root: { cid: root.cid, car: `ipfs://${carCid}` },
    artifacts: [
      {
        name: "/",
        cid: root.cid,
        size: root.bytes.length,
        codec: "directory",
        sha256: sha256(root.bytes),
      },
      {
        name: "query-table.parquet",
        cid: queryCid,
        size: queryBytes.length,
        codec: "file",
        sha256: sha256(queryBytes),
      },
      {
        name: "snapshot.car",
        cid: carCid,
        size: carBytes.length,
        codec: "file",
        sha256: sha256(carBytes),
      },
    ],
    directoryCars: [{ directoryCid: root.cid, carCid }],
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const manifestCid = computeRawCid(manifestBytes);
  const proof = (cid, bytes) => ({
    cid,
    verified: true,
    minimumIndependentGateways: 2,
    matchedGateways: gateways,
    results: gateways.map((gateway) => ({
      gateway,
      ok: true,
      status: 200,
      error: null,
      bytes: bytes.length,
      sha256: sha256(bytes),
    })),
  });
  const meta = {
    run: { runId: run, rootCid: root.cid, manifestCid, carCid },
    publicationEvidence: {
      runId: run,
      rootCid: root.cid,
      manifestCid,
      manifestBytes: manifestBytes.length,
      manifestSha256: sha256(manifestBytes),
      carCid,
      carBytes: carBytes.length,
      carSha256: sha256(carBytes),
      artifactCount: manifest.artifacts.length,
      retentionVerified: false,
      publicationPromoted: false,
    },
    verification: {
      runId: run,
      rootCid: root.cid,
      verifications: [proof(manifestCid, manifestBytes), proof(carCid, carBytes)],
    },
  };
  const bind = (value) => bindSelectedPublication(value, run, root.cid, hosted);
  const publication = bind(meta);
  assert.equal(publication.manifest.cid, manifestCid);
  assert.equal(publication.manifest.bytes, manifestBytes.length);
  assert.equal(publication.manifest.sha256, sha256(manifestBytes));
  assert.equal(publication.retentionVerified, false);
  const fields = {
    rootCid: root.cid,
    manifestCid,
    carCid,
    manifestSha256: sha256(manifestBytes),
    carSha256: sha256(carBytes),
    carSize: `${carBytes.length} bytes`,
  };
  validateOverviewFields(fields, publication, true, "Independent retention remains unverified");
  assert.throws(() =>
    validateOverviewFields(
      { ...fields, manifestCid: queryCid },
      publication,
      true,
      "Independent retention remains unverified",
    ),
  );
  assert.throws(() =>
    validateOverviewFields(
      fields,
      { ...publication, retentionVerified: true },
      true,
      "Independent retention remains unverified",
    ),
  );
  assert.equal(
    bind({ ...meta, publicationEvidence: null }).binding,
    "verified-published-run-pointer",
  );
  for (const patch of [
    { runId: "wrong-run" },
    { rootCid: queryCid },
    { manifestBytes: manifestBytes.length + 1 },
    { manifestBytes: undefined },
    { manifestSha256: `sha256:${"0".repeat(64)}` },
    { carBytes: undefined },
    { retentionVerified: undefined },
  ]) {
    assert.throws(() =>
      bind({ ...meta, publicationEvidence: { ...meta.publicationEvidence, ...patch } }),
    );
  }
  assert.throws(() => bind({ ...meta, run: { ...meta.run, manifestCid: queryCid } }));
  assert.throws(() =>
    bind({ ...meta, verification: { ...meta.verification, runId: "wrong-run" } }),
  );
  assert.throws(() => publicGateways([gateways[0], `${gateways[0]}:8443`], hosted));
  assert.throws(() => publicGateways([gateways[0], hosted], hosted));
  assert.throws(() =>
    bind({
      ...meta,
      verification: {
        ...meta.verification,
        verifications: meta.verification.verifications.map((entry) => ({
          ...entry,
          results: entry.results.map((result) => ({
            ...result,
            responseUrl: `https://one-origin.example.invalid/ipfs/${entry.cid}`,
          })),
        })),
      },
    }),
  );
  const selected = {
    runId: run,
    rootCid: root.cid,
    manifestCid,
    mode: "incremental",
    status: "succeeded",
    finishedAt: "2026-09-17T12:00:00Z",
    tables: [{ name: "permits", updated: 1 }],
  };
  const prior = {
    runId: "synthetic-prior",
    rootCid: queryCid,
    manifestCid: carCid,
    status: "succeeded",
    finishedAt: "2026-09-16T12:00:00Z",
  };
  assert.equal(incrementalHistoryPair(meta, publication), null);
  assert.equal(
    incrementalHistoryPair({ ...meta, runHistory: { runs: [prior] } }, publication),
    null,
  );
  assert.deepEqual(
    incrementalHistoryPair({ ...meta, runHistory: { runs: [selected, prior] } }, publication),
    { current: selected, prior },
  );
  assert.equal(
    incrementalHistoryPair(
      { ...meta, runHistory: { runs: [{ ...selected, status: "partial" }, prior] } },
      publication,
    ),
    null,
  );
  assert.equal(
    incrementalHistoryPair(
      {
        ...meta,
        runHistory: { runs: [{ ...selected, tables: [{ updated: 0, rowsDelta: 0 }] }, prior] },
      },
      publication,
    ),
    null,
  );
  assert.equal(
    incrementalHistoryPair(
      { ...meta, runHistory: { runs: [selected, { ...prior, rootCid: root.cid }] } },
      publication,
    ),
    null,
  );
  const fetchFixture = async () => new globalThis.Response(manifestBytes, { status: 200 });
  const retrieved = await fetchPublicManifest(publication.manifest, run, root.cid, fetchFixture);
  assert.equal(retrieved.checks.length, 2);
  assert.equal(validateSelectedCar(retrieved.manifest, publication).cid, carCid);
  assert.throws(() => validateSelectedCar({ ...manifest, directoryCars: undefined }, publication));
  assert.throws(() =>
    validateSelectedCar(manifest, { ...publication, car: { ...publication.car, bytes: 1 } }),
  );
  await assert.rejects(() =>
    fetchPublicManifest(publication.manifest, "wrong-run", root.cid, fetchFixture),
  );
  await assert.rejects(() =>
    fetchPublicManifest(
      publication.manifest,
      run,
      root.cid,
      async () => new globalThis.Response("different bytes"),
    ),
  );
  await assert.rejects(() =>
    fetchPublicManifest(
      { ...publication.manifest, gateways: [gateways[0]] },
      run,
      root.cid,
      fetchFixture,
    ),
  );
}

if (process.argv[2] === "--self-test") {
  await selfTest();
  console.log("record-preview publication binding self-tests passed");
  process.exit(0);
}

const base = process.env.DEMO_BASE_URL?.replace(/\/$/, "");
const runId = process.env.DEMO_RUN_ID;
const rootCid = process.env.DEMO_ROOT_CID;
const out = process.argv[2];
if (!base || !runId || !rootCid || !out || new URL(base).protocol !== "https:")
  throw new Error("Preview recording requires an explicit HTTPS hosted URL, run, root and output");
const startedAt = new Date().toISOString();
const get = async (route, init) => {
  const response = await globalThis.fetch(base + route, {
    ...init,
    signal: globalThis.AbortSignal.timeout(150000),
  });
  if (!response.ok) throw new Error(`Preview ${route} returned HTTP ${response.status}`);
  return response.json();
};
const [meta, health, business, tools] = await Promise.all([
  get("/api/meta/run"),
  get("/api/health"),
  get("/api/views/business"),
  get("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  }),
]);
if (
  meta.run?.runId !== runId ||
  meta.run?.rootCid !== rootCid ||
  health.runId !== runId ||
  health.rootCid !== rootCid ||
  meta.coverage?.runId !== runId ||
  meta.sourceObservationsOnly !== true ||
  meta.countyComplete !== false ||
  !business.businessesAvailable ||
  business.totals?.source_business_accounts !== meta.coverage.tables.businessAccounts.rows ||
  JSON.stringify(tools.result.tools.map((tool) => tool.name).sort()) !==
    JSON.stringify([...EXPECTED_MCP_TOOLS].sort())
)
  throw new Error(
    "Partial preview identity, coverage, business conservation or MCP contract failed",
  );
const selectedPublication = bindSelectedPublication(meta, runId, rootCid, base);
const historyPair = incrementalHistoryPair(meta, selectedPublication);
const recordedGatewayOrigins = new Set([
  ...selectedPublication.manifest.gateways,
  ...(historyPair ? publicGateways(historyPair.prior.verifiedGateways, base) : []),
]);
let overviewObservation = null;
let incrementalPublication = {
  status: "held-or-not-recorded",
  functionalCriterionFulfilled: false,
  reason:
    "No successful selected-run incremental publication receipt with measured deltas and distinct immutable predecessor is available in hosted run history.",
};
// No successful-release, new history entry, retention or current/open permit claim is fabricated.
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  ...(process.env.DEMO_CHROME_PATH ? { executablePath: process.env.DEMO_CHROME_PATH } : {}),
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  recordVideo: { dir: out, size: { width: 1280, height: 800 } },
});
const page = await context.newPage();
const failures = [];
const externalGatewayErrors = [];
const responses = [];
page.on("pageerror", (error) =>
  failures.push({ kind: "uncaught browser error", message: error.message, page: page.url() }),
);
page.on("console", (message) => {
  if (message.type() !== "error") return;
  const observed = {
    kind: "browser console error",
    message: message.text(),
    location: message.location(),
    page: page.url(),
  };
  // Favicon failures on the exact recorded public origins are not app failures
  // or failed CID retrievals. Preserve them; every other console error fails.
  if (
    [...recordedGatewayOrigins].some(
      (gateway) =>
        observed.location.url === `${gateway}/favicon.ico` &&
        observed.page.startsWith(`${gateway}/ipfs/`) &&
        /^Failed to load resource: the server responded with a status of (404|401)/.test(
          observed.message,
        ),
    )
  )
    externalGatewayErrors.push(observed);
  else failures.push(observed);
});
page.on("response", (response) => {
  if (response.url().startsWith(base + "/api/"))
    responses.push({ url: response.url(), status: response.status() });
});
const paintMonitor = await startPaintMonitor(page, base, (failure) => failures.push(failure));
let paintChecks = null;
const beats = [];
const agentAnswers = [];
const gatewayChecks = [];
let historicalPermitObservation = null;
async function beat(route, name) {
  await page.goto(base + "/#/" + route, { waitUntil: "networkidle", timeout: 120000 });
  await page.getByRole("heading", { name: "Oracle Property Intelligence", exact: true }).waitFor();
  await page.waitForFunction(
    () => !document.querySelector('[role="status"][aria-label="Loading"]'),
  );
  if (!(await page.locator("#root").innerText()).trim())
    throw new Error("Hosted preview became blank");
  await page.screenshot({ path: path.join(out, `${beats.length + 1}-${route}.png`) });
  beats.push({ route, name, observedAt: new Date().toISOString() });
  await page.waitForTimeout(3500);
}
let complete = false;
try {
  await beat("overview", "Run identity, partial coverage, source limitations and live counts");
  const overviewText = await page.locator("main").innerText();
  // Existing Kv fields abbreviate CIDs/digests visually but preserve their
  // exact values in title attributes. Inspect those actual displayed fields.
  const displayedField = async (label) =>
    page
      .locator("main .kv")
      .filter({ has: page.getByText(label, { exact: true }) })
      .locator("[title]")
      .first()
      .getAttribute("title");
  const overviewFields = {
    rootCid: await displayedField("Root CID"),
    manifestCid: await displayedField("Manifest CID"),
    carCid: await displayedField("CAR CID"),
    ...(meta.publicationEvidence
      ? {
          manifestSha256: await displayedField("Manifest SHA-256"),
          carSha256: await displayedField("CAR SHA-256"),
          carSize: await displayedField("CAR size"),
        }
      : {}),
  };
  validateOverviewFields(
    overviewFields,
    selectedPublication,
    Boolean(meta.publicationEvidence),
    overviewText,
  );
  overviewObservation = {
    observedAt: new Date().toISOString(),
    observedText: overviewText,
    observedFields: overviewFields,
    selectedPublication,
    manifestCarDisplayVerified: true,
    retentionStatusDisplayed: selectedPublication.retentionVerified,
    carLiveRetrievalPerformed: false,
  };
  await page.mouse.wheel(0, 650);
  await page.waitForTimeout(3500);
  await beat("tenant", "Ownership locality and building-age proxy bands; ten-year tenure unproven");
  await beat("business", "All source business accounts, including unmatched accounts");
  await beat("contractor", "Historical source-listed Clermont contractor names; BBB unknown");
  const candidateFilter = page.getByRole("checkbox", {
    name: "Clermont ROOF/REROOF + source ISSUED (with issue date)",
    exact: true,
  });
  const filteredResponse = page.waitForResponse(
    (response) => {
      if (response.url() !== base + "/api/sql" || response.request().method() !== "POST")
        return false;
      const request = response.request().postDataJSON();
      return (
        typeof request?.sql === "string" &&
        request.sql.includes("SELECT permit_number") &&
        request.sql.includes("WHERE source_system = 'lake_clermont_etrakit_permits'")
      );
    },
    { timeout: 60000 },
  );
  await candidateFilter.check();
  const actualResponse = await filteredResponse;
  if (actualResponse.status() !== 200) throw new Error("Historical permit filter failed");
  const actualRequest = actualResponse.request().postDataJSON();
  const historicalResult = await actualResponse.json();
  const historicalReplay = await get("/api/sql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(actualRequest),
  });
  if (
    historicalResult.provenance?.runId !== runId ||
    historicalResult.provenance?.rootCid !== rootCid ||
    !historicalResult.rows?.length ||
    JSON.stringify(historicalResult.rows) !== JSON.stringify(historicalReplay.rows) ||
    historicalResult.rows.some(
      (row) =>
        row.permit_type !== "ROOF/REROOF" || row.permit_status !== "ISSUED" || !row.issued_date,
    )
  )
    throw new Error("Historical source-listed permit evidence failed independent replay");
  const displayedHistoricalRows = await assertHistoricalRowsDisplayed(page, historicalResult.rows);
  const historicalText = await page.locator("main").innerText();
  if (!historicalText.includes("not currently open permits"))
    throw new Error("Historical records lost their current-status caveat");
  historicalPermitObservation = {
    observedAt: new Date().toISOString(),
    filter: "Literal Clermont ROOF/REROOF + source ISSUED + recorded issue date",
    evidenceState: "historical-source-observations-not-current-open",
    rowsDisplayed: historicalResult.rows.length,
    independentlyReplayed: true,
    ...displayedHistoricalRows,
    provenance: historicalResult.provenance,
    sourceRows: historicalResult.rows,
    currentOpenConclusion: false,
    durationOpenConclusion: false,
  };
  await page.locator("main table").scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(out, "historical-issued-roofing-permits.png") });
  await page.waitForTimeout(3500);
  beats.push({
    name: "Retained historical roofing permit records, not missing data",
    ...historicalPermitObservation,
  });
  await beat("search", "Coordinates and configurable aged-building roof proxy search");
  await page.getByRole("checkbox", { name: "Roof at least 15 years old", exact: true }).check();
  await page.getByLabel("Exact", { exact: true }).fill("16");
  await page.getByLabel("Latitude", { exact: true }).fill("28.5494");
  await page.getByLabel("Longitude", { exact: true }).fill("-81.7729");
  await page.getByLabel("Radius (miles)", { exact: true }).fill("5");
  await page.waitForTimeout(5000);
  const radiusResult = await get(
    "/api/properties?minRoofAge=16&lat=28.5494&lon=-81.7729&radiusMiles=5&limit=5",
  );
  if (
    !(radiusResult.matched > 0) ||
    radiusResult.provenance?.runId !== runId ||
    radiusResult.provenance?.rootCid !== rootCid ||
    !radiusResult.rows.every((row) => row.roof_age_years >= 16 && row.distance_miles <= 5)
  )
    throw new Error("Actual aged-building radius query failed");
  beats.push({
    name: "Actual radius and strictly-over-15 built-year proxy results",
    matched: radiusResult.matched,
    provenance: radiusResult.provenance,
    observedAt: new Date().toISOString(),
  });
  await page.screenshot({ path: path.join(out, "radius-search.png") });
  if (meta.chatEnabled) {
    await beat("ask", "Live agent over the selected DuckDB snapshot");
    for (const prompt of [
      "Which properties in Lake County within five miles of Clermont have roofs older than 15 years?",
      "Which properties near that area have open roofing permits that have been open for many years, and who is the listed contractor?",
    ]) {
      const count = await page.locator(".message.assistant").count();
      await page.getByLabel("Your question", { exact: true }).fill(prompt);
      const pendingChat = page.waitForResponse(
        (response) => response.url() === base + "/api/chat",
        { timeout: 135000 },
      );
      await page.getByRole("button", { name: "Send", exact: true }).click();
      const chatResponse = await pendingChat;
      if (chatResponse.status() !== 200) throw new Error("Actual agent request failed");
      const chat = await chatResponse.json();
      await page.waitForFunction(
        (previous) => document.querySelectorAll(".message.assistant").length > previous,
        count,
        { timeout: 135000 },
      );
      await page.locator(".message.assistant").last().scrollIntoViewIfNeeded();
      await page.waitForTimeout(4500);
      const answer = await page.locator(".message.assistant .message-body").last().innerText();
      if (!answer.trim()) throw new Error("Agent returned citations but no actual answer text");
      const verificationQueries = [];
      const propertyPrompt = agentAnswers.length === 0;
      const observation = {
        prompt,
        observedText: await page.locator(".message.assistant").last().innerText(),
        grounding: chat.grounding,
        groundingVerified: false,
        safeAbstentionVerified: false,
        functionalQuestionFulfilled: false,
        answerOutcome: "unverified",
        verificationQueries,
      };
      agentAnswers.push(observation);
      if (chat.runId !== runId) throw new Error("Actual chat selected a different run");
      if (propertyPrompt && chat.grounding?.mode === "no-verified-records") {
        if (
          !answer.includes("No verified") ||
          chat.grounding.evidence.some(
            (evidence) =>
              evidence.rows.length > 0 || evidence.runId !== runId || evidence.rootCid !== rootCid,
          )
        )
          throw new Error("Agent abstention contradicts its selected-run evidence");
        // A safe refusal is a demonstrated limitation, NOT a fulfilled data query.
        observation.safeAbstentionVerified = true;
        observation.answerOutcome = "no-verified-records";
      } else if (propertyPrompt) {
        if (
          chat.grounding?.mode !== "canonical-query-rows" ||
          !chat.grounding.evidence.some((item) =>
            item.rows.some((row) => typeof row.request_identifier === "string"),
          )
        )
          throw new Error("Property answer has no canonical query-row grounding");
        const centreReplay = await get("/mcp", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: {
              name: "queryProperties",
              arguments: {
                sql: "SELECT avg(latitude) AS lat, avg(longitude) AS lon FROM properties WHERE upper(coalesce(address_city, '')) = 'CLERMONT' AND latitude IS NOT NULL AND longitude IS NOT NULL",
              },
            },
          }),
        });
        const centreResult = centreReplay.result?.structuredContent;
        const centre = centreResult?.rows?.[0];
        if (
          centreReplay.result?.isError ||
          centreResult?.provenance?.runId !== runId ||
          centreResult?.provenance?.rootCid !== rootCid ||
          typeof centre?.lat !== "number" ||
          typeof centre?.lon !== "number"
        )
          throw new Error("Independent named-city centre query failed");
        verificationQueries.push({ namedCityCentre: centre, sql: centreResult.sql });
        for (const evidence of chat.grounding.evidence) {
          if (evidence.runId !== runId || evidence.rootCid !== rootCid || !evidence.sql)
            throw new Error("Agent grounding identity or actual query is missing");
          const replay = await get("/mcp", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: { name: "queryProperties", arguments: { sql: evidence.sql, limit: 200 } },
            }),
          });
          const result = replay.result?.structuredContent;
          if (
            replay.result?.isError ||
            result?.provenance?.runId !== runId ||
            result?.provenance?.rootCid !== rootCid
          )
            throw new Error("Independent agent-evidence replay failed");
          const fingerprint = (row) =>
            JSON.stringify(
              Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))),
            );
          for (const row of evidence.rows) {
            if (!result.rows.some((actual) => fingerprint(actual) === fingerprint(row)))
              throw new Error("Agent sample differs from exact hosted query rows");
            if (row.request_identifier) {
              if (
                typeof row.latitude !== "number" ||
                typeof row.longitude !== "number" ||
                !(row.roof_age_years >= 16) ||
                !row.roof_age_basis
              )
                throw new Error("Agent sample omits the requested age/coordinate evidence");
              const radians = (value) => (value * Math.PI) / 180;
              const distance =
                3958.7613 *
                2 *
                Math.asin(
                  Math.sqrt(
                    Math.sin(radians(row.latitude - centre.lat) / 2) ** 2 +
                      Math.cos(radians(centre.lat)) *
                        Math.cos(radians(row.latitude)) *
                        Math.sin(radians(row.longitude - centre.lon) / 2) ** 2,
                  ),
                );
              if (distance > 5 + 1e-8)
                throw new Error("Agent sample is outside the requested named-city radius");
            }
            for (const field of [
              "request_identifier",
              "address_street",
              "latitude",
              "longitude",
              "roof_age_years",
              "roof_age_basis",
            ]) {
              if (
                row.request_identifier &&
                row[field] !== null &&
                row[field] !== undefined &&
                !answer.includes(String(row[field]))
              )
                throw new Error(`Displayed agent ${field} differs from canonical evidence`);
            }
          }
          verificationQueries.push({ sql: evidence.sql, verifiedRows: evidence.rows.length });
        }
        observation.groundingVerified = true;
        observation.functionalQuestionFulfilled = true;
        observation.answerOutcome = "canonical-query-rows";
      } else if (chat.grounding?.mode !== "source-only-refusal") {
        throw new Error(
          "Source-only open-permit prompt did not explicitly refuse unsupported decisions",
        );
      } else {
        if (
          chat.grounding.runId !== runId ||
          chat.grounding.rootCid !== rootCid ||
          chat.grounding.capabilities?.currentOpenPermitStatus !== "unsupported" ||
          chat.grounding.capabilities?.openPermitDuration !== "unsupported"
        )
          throw new Error("Agent refusal is not bound to unsupported selected-run capabilities");
        observation.safeAbstentionVerified = true;
        observation.answerOutcome = "source-only-refusal";
      }
      beats.push({
        name: prompt,
        observedAt: new Date().toISOString(),
        liveAgentAnswered: true,
        functionalQuestionFulfilled: observation.functionalQuestionFulfilled,
      });
    }
    await page.screenshot({ path: path.join(out, "agent-answers.png") });
  }
  await beat("sql", "Read-only DuckDB query explorer");
  await page
    .getByLabel("Statement", { exact: true })
    .fill("SELECT count(*) AS properties, count(latitude) AS coordinates FROM properties");
  await page.getByRole("button", { name: "Run query", exact: true }).click();
  await page.getByRole("heading", { name: "Result", exact: true }).waitFor();
  await page.screenshot({ path: path.join(out, "duckdb-query.png") });
  beats.push({
    name: "Executed read-only DuckDB query through hosted UI",
    observedText: await page.locator("main").innerText(),
    observedAt: new Date().toISOString(),
  });
  const selectedPublicManifest = await fetchPublicManifest(
    selectedPublication.manifest,
    runId,
    rootCid,
  );
  const selectedCar = validateSelectedCar(selectedPublicManifest.manifest, selectedPublication);
  gatewayChecks.push(...selectedPublicManifest.checks);
  overviewObservation.publicManifestCarBindingVerified = true;
  overviewObservation.carArtifact = selectedCar;
  for (const check of selectedPublicManifest.checks) {
    await page.goto(`${check.gateway}/ipfs/${check.cid}`, { waitUntil: "load", timeout: 60000 });
    await page.waitForTimeout(4000);
    beats.push({ name: "Actual selected public manifest retrieval by CID", ...check });
  }
  await page.screenshot({ path: path.join(out, "public-manifest.png") });
  if (historyPair) {
    const priorPublicManifest = await fetchPublicManifest(
      {
        cid: historyPair.prior.manifestCid,
        gateways: publicGateways(historyPair.prior.verifiedGateways, base),
      },
      historyPair.prior.runId,
      historyPair.prior.rootCid,
    );
    const changedArtifacts = selectedPublicManifest.manifest.artifacts.filter((entry) => {
      const prior = priorPublicManifest.manifest.artifacts.find((old) => old.name === entry.name);
      return (
        entry.codec === "file" &&
        ["query-table.parquet", "permit-table.parquet", "business-table.parquet"].includes(
          entry.name,
        ) &&
        prior?.codec === "file" &&
        prior.cid !== entry.cid &&
        prior.sha256 !== entry.sha256
      );
    });
    if (!changedArtifacts.length)
      throw new Error(
        "Incremental history deltas do not have changed published data artifact CIDs",
      );
    const changedData =
      changedArtifacts.find((entry) => entry.name === "permit-table.parquet") ??
      changedArtifacts[0];
    const priorData = priorPublicManifest.manifest.artifacts.find(
      (entry) => entry.name === changedData.name,
    );
    const changedDataChecks = [];
    for (const [artifact, gateways, snapshotRun] of [
      [
        priorData,
        priorPublicManifest.checks.map((check) => check.gateway),
        historyPair.prior.runId,
      ],
      [changedData, selectedPublication.manifest.gateways, runId],
    ]) {
      const recorded =
        snapshotRun === runId
          ? meta.verification.verifications.find((entry) => entry.cid === artifact.cid)
          : null;
      const origins = recorded
        ? proofBinding(recorded, base, { bytes: artifact.size, sha256: artifact.sha256 }).gateways
        : gateways;
      const proof = await verifyArtifactAcrossGateways({
        cid: artifact.cid,
        codec: artifact.codec,
        expectedSize: artifact.size,
        expectedSha256: artifact.sha256,
        gateways: origins,
      });
      if (!proof.verified)
        throw new Error("Old/new changed data artifact public byte replay failed");
      changedDataChecks.push({ runId: snapshotRun, artifact, proof });
    }
    const rootChecks = [];
    for (const [manifest, checks] of [
      [priorPublicManifest.manifest, priorPublicManifest.checks],
      [selectedPublicManifest.manifest, selectedPublicManifest.checks],
    ]) {
      const artifact = manifest.artifacts.find((entry) => entry.cid === manifest.root.cid);
      if (artifact?.codec !== "directory")
        throw new Error("Incremental snapshot root is not a declared directory artifact");
      const proof = await verifyArtifactAcrossGateways({
        cid: artifact.cid,
        codec: artifact.codec,
        expectedSize: artifact.size,
        expectedSha256: artifact.sha256,
        gateways: checks.map((check) => check.gateway),
      });
      if (!proof.verified) throw new Error("Old/new immutable root public byte replay failed");
      rootChecks.push({ runId: manifest.runId, rootCid: manifest.root.cid, proof });
    }
    incrementalPublication = {
      status: "public-history-replay-verified",
      functionalCriterionFulfilled: true,
      currentReceipt: historyPair.current,
      predecessorReceipt: historyPair.prior,
      manifestChecks: [...priorPublicManifest.checks, ...selectedPublicManifest.checks],
      rootChecks,
      changedArtifacts,
      changedDataChecks,
      scope:
        "Recorded real incremental deltas, distinct immutable roots/manifests and a changed data-artifact pair with fresh two-gateway byte matches; not a fresh verification of every listed object or an independent-retention certification.",
    };
    const priorCheck = priorPublicManifest.checks[0];
    await page.goto(`${priorCheck.gateway}/ipfs/${priorCheck.cid}`, {
      waitUntil: "load",
      timeout: 60000,
    });
    await page.waitForTimeout(4000);
    await page.screenshot({ path: path.join(out, "prior-public-manifest.png") });
    beats.push({ name: "Actual immutable predecessor manifest replay", ...priorCheck });
    const currentCheck = selectedPublicManifest.checks[0];
    await page.goto(`${currentCheck.gateway}/ipfs/${currentCheck.cid}`, {
      waitUntil: "load",
      timeout: 60000,
    });
    await page.waitForTimeout(4000);
    beats.push({ name: "Actual later incrementally published manifest replay", ...currentCheck });
  }
  paintChecks = await paintMonitor.stop();
  if (paintChecks.domChecks === 0 || paintChecks.screenshotSamples === 0)
    throw new Error("Hosted preview has no actual app paint checks");
  if (failures.length || responses.some((response) => response.status >= 500))
    throw new Error(`Preview runtime failures: ${JSON.stringify({ failures, responses })}`);
  complete = true;
} finally {
  paintChecks ??= await paintMonitor.stop();
  const video = page.video();
  await context.close();
  await browser.close();
  if (video) {
    const videoPath = await video.path();
    const bytes = await readFile(videoPath);
    const finalVideoPath = path.join(out, "walkthrough.webm");
    await rename(videoPath, finalVideoPath);
    const report = {
      schemaVersion: "oracle.hosted-partial-preview-demo.v1",
      startedAt,
      finishedAt: new Date().toISOString(),
      baseUrl: base,
      runId,
      rootCid,
      scope: "source_only_partial_preview",
      recordingCompleted: complete,
      fullAssignmentDemoPassed: false,
      independentRetentionVerified: selectedPublication.retentionVerified === true,
      publicationPromoted: selectedPublication.publicationPromoted === true,
      publicationObservation: overviewObservation,
      incrementalPublication,
      countyComplete: false,
      browserErrors: failures,
      paintChecks,
      externalGatewayErrors,
      apiResponses: responses,
      beats,
      agentAnswers,
      historicalPermitObservation,
      gatewayChecks,
      video: {
        filename: path.basename(finalVideoPath),
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      limitations: [
        "Current/open roofing permit status, duration and legal identity remain unaccepted.",
        "Built year is a low-confidence roof-age proxy, not measured roof age.",
        "Ten-year ownership tenure and BBB scores are not established.",
        ...(selectedPublication.retentionVerified === true
          ? []
          : ["Independent retention is not verified by the selected hosted publication evidence."]),
        ...(incrementalPublication.functionalCriterionFulfilled
          ? []
          : [
              "Later incremental public IPFS publication has not been demonstrated for this selected run.",
            ]),
      ],
    };
    await writeFile(
      path.join(out, complete ? "preview-demo.json" : "failed-preview-demo.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(JSON.stringify(report));
  }
}
