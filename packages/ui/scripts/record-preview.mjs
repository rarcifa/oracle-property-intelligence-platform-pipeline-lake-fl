/** Actual hosted partial-data walkthrough. This is NOT the strict passed full demo. */
import { chromium } from "@playwright/test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { URL } from "node:url";
import { EXPECTED_MCP_TOOLS } from "./demo-contract.mjs";

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
const responses = [];
page.on("pageerror", () => failures.push("uncaught browser error"));
page.on("console", (message) => {
  if (message.type() === "error") failures.push("browser console error");
});
page.on("response", (response) => {
  if (response.url().startsWith(base + "/api/"))
    responses.push({ url: response.url(), status: response.status() });
});
const beats = [];
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
  await page.mouse.wheel(0, 650);
  await page.waitForTimeout(3500);
  await beat("tenant", "Ownership locality and building-age proxy bands; ten-year tenure unproven");
  await beat("business", "All source business accounts, including unmatched accounts");
  await beat("contractor", "Historical source-listed Clermont contractor names; BBB unknown");
  await beat("search", "Coordinates and configurable aged-building roof proxy search");
  await page.getByLabel("Exact", { exact: true }).fill("16");
  await page.getByLabel("Latitude", { exact: true }).fill("28.5494");
  await page.getByLabel("Longitude", { exact: true }).fill("-81.7729");
  await page.getByLabel("Radius (miles)", { exact: true }).fill("5");
  await page.waitForTimeout(5000);
  await page.screenshot({ path: path.join(out, "radius-search.png") });
  if (meta.chatEnabled) {
    await beat("ask", "Live model agent over the selected DuckDB snapshot");
    for (const prompt of [
      "Which properties in Lake County within five miles of Clermont have roofs older than 15 years?",
      "Which properties near that area have open roofing permits that have been open for many years, and who is the listed contractor?",
    ]) {
      const count = await page.locator(".message.assistant").count();
      await page.getByLabel("Your question", { exact: true }).fill(prompt);
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await page.waitForFunction(
        (previous) => document.querySelectorAll(".message.assistant").length > previous,
        count,
        { timeout: 135000 },
      );
      await page.locator(".message.assistant").last().scrollIntoViewIfNeeded();
      await page.waitForTimeout(4500);
      beats.push({ name: prompt, observedAt: new Date().toISOString(), liveAgentAnswered: true });
    }
    await page.screenshot({ path: path.join(out, "agent-answers.png") });
  }
  await beat("sql", "Read-only DuckDB query explorer");
  if (failures.length || responses.some((response) => response.status >= 500))
    throw new Error(`Preview runtime failures: ${JSON.stringify({ failures, responses })}`);
  complete = true;
} finally {
  const video = page.video();
  await context.close();
  await browser.close();
  if (complete && video) {
    const videoPath = await video.path();
    const bytes = await readFile(videoPath);
    const report = {
      schemaVersion: "oracle.hosted-partial-preview-demo.v1",
      startedAt,
      finishedAt: new Date().toISOString(),
      baseUrl: base,
      runId,
      rootCid,
      scope: "source_only_partial_preview",
      fullAssignmentDemoPassed: false,
      independentRetentionVerified: false,
      publicationPromoted: false,
      countyComplete: false,
      browserErrors: failures,
      apiResponses: responses,
      beats,
      video: {
        filename: path.basename(videoPath),
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      limitations: [
        "Current/open roofing permit status, duration and legal identity remain unaccepted.",
        "Built year is a low-confidence roof-age proxy, not measured roof age.",
        "Ten-year ownership tenure and BBB scores are not established.",
        "Independent retention and later incremental IPFS promotion remain held.",
      ],
    };
    await writeFile(path.join(out, "preview-demo.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report));
  }
}
