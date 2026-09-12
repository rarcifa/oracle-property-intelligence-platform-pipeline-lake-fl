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
import { assertDemoContract } from "./demo-contract.mjs";

const BASE = process.env.DEMO_BASE_URL?.replace(/\/$/, "");
const OUT = process.argv[2] ?? "demo-out";
const RUN_ID = process.env.DEMO_RUN_ID;
const ROOT_CID = process.env.DEMO_ROOT_CID;
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
  await q.type("aged roofs with an open roofing permit in Clermont", { delay: 55 });
  await caption(
    page,
    "2 · Interpreted into filters",
    "The phrase is parsed into explicit filters — roof age, permit state, city — so the query stays inspectable rather than opaque.",
    2000,
  );
  await q.press("Enter");
  await wait(7000);
  await reveal(page, 560);
  await caption(
    page,
    "2 · Results, with their evidence",
    "Every row carries roof age, the basis that age was derived from, coordinates and its source system.",
    8000,
  );
  await reveal(page, 900);
  await wait(6500);

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
    `${release.business.sourceAccounts.toLocaleString()} TPP accounts in this release's source roll; ${release.business.matchedToParcel.toLocaleString()} match a parcel by street and ZIP, because the roll carries no parcel key.`,
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
    "Within five miles of Clermont, which properties have roofs older than 15 years and an open roofing permit — and who is the contractor?",
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
      /contractor/i.test(document.body.innerText) &&
      /Clermont/i.test(document.body.innerText) &&
      !/Thinking/i.test(document.body.innerText),
    "the agent to finish with Clermont-bounded contractor semantics",
    170000,
  );
  await wait(3000);
  await reveal(page, 620);
  await caption(
    page,
    "6 · Contractor identity stays inside its evidence boundary",
    "It reports only source-backed Clermont contractor evidence, distinguishes an established absence from a gated null, and never turns one municipality into countywide coverage.",
    11000,
  );
  await reveal(page, 700);
  await wait(7000);

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
  completed = true;
} finally {
  await ctx.close();
  await b.close();
  if (completed) console.log("complete release demo written under", OUT);
}
