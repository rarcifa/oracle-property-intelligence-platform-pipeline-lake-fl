/**
 * Records the Lake County demo against the DEPLOYED runtime.
 *
 * Everything on screen is live: the UI is the hosted Function URL, and the
 * retrieval beats navigate to real public IPFS gateways. Nothing is mocked,
 * reconstructed or typed into a fake terminal — if a beat renders, the runtime
 * served it.
 *
 * Usage: pnpm --filter @oracle-lake/ui exec node scripts/record-demo.mjs [outDir]
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { assertDemoContract } from "./demo-contract.mjs";
import { validateArtifactManifest } from "../../../pipeline/src/core/artifact-manifest.mjs";
import {
  verifyArtifactAcrossGateways,
  verifyManifestAcrossGateways,
} from "../../../pipeline/src/core/gateway-verify.mjs";

const BASE = process.env.DEMO_BASE_URL?.replace(/\/$/, "");
const OUT = process.argv[2] ?? "demo-out";
const RUN_ID = process.env.DEMO_RUN_ID;
const ROOT_CID = process.env.DEMO_ROOT_CID;
const MANIFEST_PATH = process.env.DEMO_MANIFEST_PATH;
const PRIOR_MANIFEST_PATH = process.env.DEMO_PRIOR_MANIFEST_PATH;
const W = 1600,
  H = 900;

if (!BASE || !RUN_ID || !ROOT_CID) {
  throw new Error(
    "record-demo requires DEMO_BASE_URL, DEMO_RUN_ID and DEMO_ROOT_CID for one explicit release",
  );
}

async function responseJson(path, init) {
  const response = await globalThis.fetch(`${BASE}${path}`, init);
  if (!response.ok) throw new Error(`${path} answered HTTP ${response.status}`);
  return response.json();
}

// Fail before launching a browser or creating a video if the deployed API is
// stale, incomplete, or describing a different release than the operator chose.
const [meta, tools, contractor, business] = await Promise.all([
  responseJson("/api/meta/run"),
  responseJson("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "demo-contract", method: "tools/list" }),
  }),
  responseJson("/api/views/contractor"),
  responseJson("/api/views/business"),
]);
const release = assertDemoContract({
  meta,
  tools,
  contractor,
  business,
  expectedRunId: RUN_ID,
  expectedRootCid: ROOT_CID,
});

// Recorded vendor URLs and older selective receipts are not fresh publication
// proof. Verify the actual current inventory and a changed predecessor artifact.
if (!MANIFEST_PATH || !PRIOR_MANIFEST_PATH) {
  throw new Error("record-demo requires DEMO_MANIFEST_PATH and DEMO_PRIOR_MANIFEST_PATH");
}
const manifestBytes = await readFile(MANIFEST_PATH);
const manifest = validateArtifactManifest(JSON.parse(manifestBytes.toString("utf8")));
const priorManifest = validateArtifactManifest(
  JSON.parse(await readFile(PRIOR_MANIFEST_PATH, "utf8")),
);
if (
  manifest.runId !== RUN_ID ||
  manifest.root.cid !== ROOT_CID ||
  !manifest.directoryCars?.length
) {
  throw new Error("demo manifest must match this release and deliver CARs for every directory");
}
const currentRun = meta.runHistory?.runs?.find((run) => run.runId === RUN_ID);
const priorRun = meta.runHistory?.runs?.find((run) => run.runId === priorManifest.runId);
const queryArtifact = manifest.artifacts.find((entry) => entry.name === "query-table.parquet");
const priorQueryArtifact = priorManifest.artifacts.find(
  (entry) => entry.name === "query-table.parquet",
);
if (
  currentRun?.mode !== "incremental" ||
  currentRun?.status !== "succeeded" ||
  priorRun?.status !== "succeeded" ||
  priorRun.rootCid !== priorManifest.root.cid ||
  priorManifest.runId >= RUN_ID ||
  priorManifest.root.cid === ROOT_CID ||
  !queryArtifact ||
  !priorQueryArtifact ||
  queryArtifact.sha256 === priorQueryArtifact.sha256
) {
  throw new Error(
    "demo requires a successful incremental snapshot with changed data and an immutable predecessor in history",
  );
}
const publicProof = await verifyManifestAcrossGateways({ manifest });
if (!publicProof.verified || publicProof.checkedArtifacts !== manifest.artifacts.length) {
  throw new Error(
    "every listed CID must match size/digest through two independent public gateways",
  );
}
const manifestProof = await verifyArtifactAcrossGateways({
  cid: meta.run.manifestCid,
  expectedSize: manifestBytes.length,
  expectedSha256: `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`,
});
const priorProof = await verifyArtifactAcrossGateways({
  cid: priorQueryArtifact.cid,
  expectedSize: priorQueryArtifact.size,
  expectedSha256: priorQueryArtifact.sha256,
  codec: priorQueryArtifact.codec,
});
if (!manifestProof.verified || !priorProof.verified) {
  throw new Error("manifest and prior immutable query bytes must remain publicly retrievable");
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Inject (or refresh) the caption bar. Survives SPA routing; re-run after goto. */
async function caption(page, title, body, ms = 0) {
  await page.evaluate(
    ([t, b]) => {
      let el = document.getElementById("__demo_caption");
      if (!el) {
        el = document.createElement("div");
        el.id = "__demo_caption";
        el.style.cssText = [
          "position:fixed",
          "left:0",
          "right:0",
          "bottom:0",
          "z-index:2147483647",
          "font:500 20px/1.45 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif",
          "padding:18px 34px 22px",
          "color:#f8fafc",
          "background:linear-gradient(to top,rgba(2,6,23,.97) 62%,rgba(2,6,23,0))",
          "pointer-events:none",
          "transition:opacity .25s ease",
        ].join(";");
        document.body.appendChild(el);
      }
      el.style.opacity = "1";
      el.innerHTML =
        '<div style="font:600 13px/1 ui-sans-serif,system-ui;letter-spacing:.14em;text-transform:uppercase;color:#7dd3fc;margin-bottom:7px">' +
        t +
        "</div><div>" +
        b +
        "</div>";
    },
    [title, body],
  );
  if (ms) await wait(ms);
}

async function go(page, path, title, body, settle = 3200) {
  await page.goto(BASE + path, { waitUntil: "networkidle", timeout: 120000 });
  await wait(settle);
  await caption(page, title, body);
}

/**
 * Wait for the page to actually reach a state, rather than sleeping and hoping.
 *
 * Fixed sleeps produced a take in which the agent was still thinking while the
 * caption said it had answered — the recording asserted something the screen
 * did not show.
 *
 * @param {import("@playwright/test").Page} page - Page.
 * @param {() => boolean} predicate - Runs in the browser; true when ready.
 * @param {string} what - What is being waited for, for the failure message.
 * @param {number} [timeout] - Milliseconds before giving up.
 * @returns {Promise<void>}
 */
async function until(page, predicate, what, timeout = 120000) {
  try {
    await page.waitForFunction(predicate, null, { timeout, polling: 500 });
  } catch {
    throw new Error(`demo beat never became ready: ${what}`);
  }
}

/** Scroll smoothly so the recording reads as a walkthrough, not a slideshow. */
async function reveal(page, px = 900, ms = 2600) {
  await page.evaluate(
    ([p, d]) =>
      new Promise((res) => {
        const start = window.scrollY,
          t0 = performance.now();
        (function step(now) {
          const k = Math.min(1, (now - t0) / d);
          window.scrollTo(0, start + p * (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2));
          if (k < 1) requestAnimationFrame(step);
          else res();
        })(t0);
      }),
    [px, ms],
  );
  await wait(700);
}

const b = await chromium.launch({
  args: ["--force-color-profile=srgb", "--font-render-hinting=none"],
});
mkdirSync(OUT, { recursive: true });
const ctx = await b.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
  recordVideo: { dir: OUT, size: { width: W, height: H } },
});
const page = await ctx.newPage();
const browserFailures = [];
page.on("pageerror", () => browserFailures.push("uncaught browser error"));
page.on("console", (message) => {
  if (message.type() === "error") browserFailures.push("browser console error");
});

let completed = false;
try {
  // 1 — the run, and the CID it is pinned to
  await go(
    page,
    "/#/tenant",
    "1 · The published run",
    "One Lambda, no database. The header names the run and the immutable root CID the browser is reading from public IPFS.",
    5200,
  );
  // The browser engine loads DuckDB-WASM and range-reads the Parquet by CID,
  // falling back to server compute if that is slow to come up. A take that
  // opened on the fallback showed "Server DuckDB" through a walkthrough whose
  // point is that no server is in the data path.
  await until(
    page,
    () => /Browser DuckDB-WASM/i.test(document.body.innerText),
    "the browser DuckDB-WASM engine to come up",
  );
  await wait(4200);
  await reveal(page, 780);
  await caption(
    page,
    "1 · Tenant view",
    "Owner posture, mailing state and roof-age bands — computed in the browser with DuckDB-WASM, range-reading the published Parquet by CID.",
    7000,
  );
  await reveal(page, 820);
  await wait(5200);

  // 2 — search: a real typed query against the published table
  await go(
    page,
    "/#/search",
    "2 · Ask the table in plain English",
    "The assignment's first question, typed into the live runtime.",
    4200,
  );
  const q = page.getByLabel("Search in plain English");
  await q.click();
  await q.type("aged roofs in Clermont", { delay: 55 });
  await caption(
    page,
    "2 · Interpreted into filters",
    "Inspect the interpreted center, five-mile radius and age threshold. Year built is a low-confidence building-age proxy, not measured roof age.",
    2000,
  );
  await q.press("Enter");
  await wait(7000);
  await page.getByLabel("Latitude", { exact: true }).fill("28.5494");
  await page.getByLabel("Longitude", { exact: true }).fill("-81.7729");
  await page.getByLabel("Radius (miles)", { exact: true }).fill("5");
  // Ages are whole years. Strictly older than 15 is an at-least-16 filter.
  await page.getByLabel("Exact", { exact: true }).fill("16");
  await wait(1500);
  await reveal(page, 560);
  await caption(
    page,
    "2 · Results, with their evidence",
    "Every row carries roof age, the basis that age was derived from, coordinates and its source system.",
    8000,
  );
  await reveal(page, 900);
  await wait(6500);

  await q.fill("open roofing permits in Clermont");
  await q.press("Enter");
  await wait(1000);
  await page.getByLabel("Latitude", { exact: true }).fill("28.5494");
  await page.getByLabel("Longitude", { exact: true }).fill("-81.7729");
  await page.getByLabel("Radius (miles)", { exact: true }).fill("5");
  await page.getByLabel("Minimum roofing permit days open").fill("365");
  await until(
    page,
    () => !/Loading|Searching/i.test(document.body.innerText),
    "open roofing permit results",
  );
  await caption(
    page,
    "2 · Open roofing permits",
    "Inspect permit status, lifecycle dates, duration/as-of basis and source-listed contractor; unavailable BBB ratings remain null.",
    6500,
  );

  // 3 — the honest gap
  await go(
    page,
    "/#/contractor",
    "3 · Partial contractor evidence, stated exactly",
    `Contractor of record is harvested for Clermont permit years ${release.contractorPermitYears[0]}–${release.contractorPermitYears.at(-1)}; the other 14 jurisdictions and BBB remain gated.`,
    5200,
  );
  await wait(5000);
  await caption(
    page,
    "3 · One of fifteen jurisdictions — never countywide",
    `${release.contractorNames.toLocaleString()} parcel rows carry a Clermont contractor name. BBB stays at zero with its HTTP 403 reason; nulls elsewhere are never filled by inference.`,
    8500,
  );
  await reveal(page, 820);
  await wait(6000);

  // 4 — business coverage, stated honestly
  await go(
    page,
    "/#/business",
    "4 · Business view",
    `${release.business.sourceAccounts.toLocaleString()} TPP source accounts are queryable, including ${release.business.unmatchedAccounts.toLocaleString()} valid unmatched accounts. ${release.business.matchedToParcel.toLocaleString()} match a parcel by normalized street and ZIP.`,
    5200,
  );
  await wait(5500);
  await caption(
    page,
    "4 · The double count, declared",
    `Summing per-parcel counts gives ${release.business.attributedAcrossParcels.toLocaleString()} across ${release.business.propertiesWithAccount.toLocaleString()} parcels — ${release.business.sharedAddressGroups.toLocaleString()} shared-address groups are attributed to every parcel at that address. These values came from the selected run, not the script.`,
    9000,
  );
  await reveal(page, 900);
  await wait(6000);

  // 5 — SQL console: a real query, then the lockdown refusing one
  await go(
    page,
    "/#/sql",
    "5 · Read-only SQL, in the browser",
    "No database server anywhere. DuckDB-WASM over the same Parquet, read by CID.",
    4200,
  );
  const ta = page.locator("textarea").first();
  await ta.click();
  await ta.fill("");
  await ta.type(
    "SELECT address_city, count(*) AS aged_roofs\n  FROM properties\n WHERE roof_age_years >= 15\n GROUP BY 1 ORDER BY 2 DESC LIMIT 10",
    { delay: 26 },
  );
  await wait(1200);
  await page.getByRole("button", { name: "Run query" }).click();
  await wait(7000);
  await caption(
    page,
    "5 · Answered in the browser",
    "The query ran client-side against the published Parquet — no backend query service in the path.",
    7500,
  );
  await reveal(page, 520);
  await wait(4000);
  await page.getByRole("button", { name: "Try a rejected statement" }).click();
  await wait(2500);
  await caption(
    page,
    "5 · And the surface is locked to reads",
    "A statement that tries to leave the dataset is refused rather than sanitised — the console only ever reads.",
    8000,
  );
  await wait(4500);

  // 6 — the agent, asked the assignment's hardest question
  await go(
    page,
    "/#/ask",
    "6 · The agent, on the same data",
    "Natural language in, source-backed answers out.",
    4200,
  );
  const ask = page.locator("textarea").first();
  await ask.click();
  await ask.type(
    "Which properties in Lake County within five miles of Clermont have roofs older than 15 years? Explain the roof-age proxy and cite the source records.",
    { delay: 34 },
  );
  await wait(1000);
  await page.getByRole("button", { name: "Send" }).click();
  await caption(
    page,
    "6 · Answering from the published run",
    "The second half crosses an evidence boundary: contractor names may exist for Clermont permits, while the other jurisdictions and BBB remain gated.",
    3000,
  );
  // Wait for the answer itself. A take captioned "it refuses to invent the
  // contractor" over a spinner, because the caption ran on a timer. The marker
  // must be something that cannot exist before the answer does: "CITATIONS" is
  // a heading that renders early, so key on a citation carrying real SQL.
  await until(
    page,
    () =>
      /SQL THIS CITATION RAN/i.test(document.body.innerText) &&
      /roof/i.test(document.body.innerText) &&
      /Clermont/i.test(document.body.innerText) &&
      !/Thinking/i.test(document.body.innerText),
    "the agent to finish with source-backed Lake County radius and roof-age evidence",
    170000,
  );
  await wait(3000);
  await reveal(page, 620);
  await caption(
    page,
    "6 · Contractor identity stays inside its evidence boundary",
    "Read the actual source-backed answer and its assumptions; building age is not measured roof age, and partial permit history may omit replacements.",
    11000,
  );
  await reveal(page, 700);
  await wait(7000);

  await ask.fill(
    "Which properties within five miles of Clermont have open roofing permits that have been open for many years, and who is the listed contractor? Include status, open-duration basis and BBB rating where available; identify missing data.",
  );
  await page.getByRole("button", { name: "Send" }).click();
  await until(
    page,
    () => {
      const answers = document.querySelectorAll("article.message.assistant");
      return (
        answers.length >= 2 &&
        /SQL THIS CITATION RAN/i.test(answers[answers.length - 1].innerText) &&
        !/Thinking/i.test(document.body.innerText)
      );
    },
    "the second source-backed roofing agent answer",
    170000,
  );
  await caption(
    page,
    "6 · Long-open permits and listed contractors",
    "Inspect the second actual answer, permit evidence, as-of/duration assumptions and conditional missing BBB data. A name is not verified legal identity.",
    10000,
  );

  // 7 — retrieval from a real public gateway
  const cov = `https://ipfs.filebase.io/ipfs/${ROOT_CID}/coverage.json`;
  const coverageResponse = await page.goto(cov, {
    waitUntil: "domcontentloaded",
    timeout: 120000,
  });
  if (!coverageResponse?.ok()) {
    throw new Error(`public IPFS coverage beat answered HTTP ${coverageResponse?.status() ?? 0}`);
  }
  await wait(2200);
  await caption(
    page,
    "7 · Fetched from public IPFS, not from the app",
    "This is the coverage snapshot retrieved by CID from a public gateway — the same bytes the runtime reads, with every limitation machine-readable.",
    9000,
  );
  await reveal(page, 700);
  await wait(6000);
  await reveal(page, 900);
  await wait(6000);

  // The preceding fresh readback hashed every object, including directory
  // blocks and the delivered multi-root CAR. Show real manifest retrieval from
  // the two successful independent gateways, then real immutable run history.
  for (const gateway of manifestProof.matchedGateways.slice(0, 2)) {
    const response = await page.goto(`${gateway}/ipfs/${meta.run.manifestCid}`, {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    });
    if (!response?.ok()) throw new Error("public manifest retrieval failed during the recording");
    await caption(
      page,
      "8 · Public manifest by CID",
      `Every one of this manifest's ${manifest.artifacts.length} listed objects passed live two-gateway size/digest checks before recording, including directories and the actual CAR file.`,
      7000,
    );
  }
  await go(
    page,
    "/api/meta/run",
    "9 · Immutable incremental run history",
    "The later incremental snapshot has changed query bytes and a new CID; its predecessor still retrieves publicly. Both snapshots remain in this actual run history.",
    1000,
  );
  await wait(6000);
  await go(
    page,
    "/#/tenant",
    "10 · Oracle and builder responsibilities",
    "Real Lake County collection, provenance, limitations, portable consumer-side DuckDB and public snapshots are shown together. Optional hosting, model usage and durable retention are funded explicitly, not silently charged to Oracle.",
    1800,
  );
  if (browserFailures.length)
    throw new Error(
      `recording observed ${browserFailures.length} browser errors; do not submit this take`,
    );
  if (!(await page.locator("#root").innerText()).trim())
    throw new Error("hosted application became blank");
  completed = true;
} finally {
  await ctx.close();
  await b.close();
  if (completed) console.log("complete release demo written under", OUT);
}
