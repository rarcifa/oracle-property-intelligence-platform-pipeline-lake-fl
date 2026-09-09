/**
 * Shared setup and geometry helpers for the mocked design lane.
 *
 * Determinism comes from three things, all applied before the first paint:
 * every off-origin request is blocked (no OSM tiles, no jsDelivr DuckDB
 * bootstrap), every `/api` response is a fixture captured from the running
 * server, and the data path is pinned to "server" in `localStorage` so the
 * provider never races a WASM boot that these tests do not care about.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page } from "@playwright/test";

/** `localStorage` key the data-source provider reads its pinned path from. */
const DATA_MODE_KEY = "oracle-lake.data-mode";

function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../fixtures/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Captured from `http://127.0.0.1:8791/api/*` against the published Lake run. */
export const FIXTURES = {
  run: fixture("run"),
  facets: fixture("facets"),
  stats: fixture("stats"),
  tenant: fixture("tenant"),
  business: fixture("business"),
  contractor: fixture("contractor"),
  search: fixture("search"),
} as const;

/**
 * Serve every data surface from a fixture and refuse every off-origin request,
 * so a spec measures layout and never the network.
 */
export async function mockPublishedRun(page: Page): Promise<void> {
  // Registered first, so it is the lowest-priority handler: same-origin assets
  // continue, anything else is refused.
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (url.startsWith("http://127.0.0.1:") || url.startsWith("http://localhost:")) {
      await route.continue();
      return;
    }
    await route.abort();
  });

  const json = (body: unknown) => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

  await page.route(/\/api\/meta\/run$/, (route) => route.fulfill(json(FIXTURES.run)));
  await page.route(/\/api\/meta\/facets$/, (route) => route.fulfill(json(FIXTURES.facets)));
  await page.route(/\/api\/stats$/, (route) => route.fulfill(json(FIXTURES.stats)));
  await page.route(/\/api\/views\/tenant$/, (route) => route.fulfill(json(FIXTURES.tenant)));
  await page.route(/\/api\/views\/business$/, (route) => route.fulfill(json(FIXTURES.business)));
  await page.route(/\/api\/views\/contractor$/, (route) =>
    route.fulfill(json(FIXTURES.contractor)),
  );
  await page.route(/\/api\/properties(\?|$)/, (route) => route.fulfill(json(FIXTURES.search)));
}

/**
 * Pin the server data path before the app boots. Without this the provider may
 * start DuckDB-WASM, which is blocked here and would only add a mode-pill race.
 */
export async function pinServerDataPath(page: Page): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // Private windows: the provider falls back to the server path anyway.
      }
    },
    [DATA_MODE_KEY, "server"] as const,
  );
}

/** Open a hash route and wait until the view is painted and settled. */
export async function gotoView(page: Page, route: string, ready: string): Promise<void> {
  await page.goto(`/#${route}`);
  await page.waitForLoadState("domcontentloaded");
  await page.waitForSelector(".app-header");
  await page.waitForSelector(ready);
  // The pill leaves "connecting" once the run pointer resolves; waiting for it
  // means no assertion is taken during the header's own layout shift.
  await expect(page.locator(".mode-pill.server")).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

/** A bounding box that is known to exist. */
export async function ensureBox(locator: Locator): Promise<{
  x: number;
  y: number;
  width: number;
  height: number;
}> {
  const box = await locator.boundingBox();
  expect(box, "element has no bounding box").not.toBeNull();
  return box as { x: number; y: number; width: number; height: number };
}

/**
 * Number of tracks a CSS grid actually renders.
 *
 * `repeat(auto-fit, ...)` collapses the tracks it has no items for, and the
 * computed value still lists them as `0px`; counting those would report a
 * two-panel row as four columns.
 */
export async function gridColumnCount(locator: Locator): Promise<number> {
  return locator.evaluate(
    (element) =>
      window
        .getComputedStyle(element)
        .gridTemplateColumns.split(" ")
        .filter((track) => track.length > 0 && parseFloat(track) > 0).length,
  );
}

export interface Overflow {
  selector: string;
  right: number;
  left: number;
  limit: number;
}

/**
 * Elements that reach past the viewport without living inside a scroller of
 * their own.
 *
 * `body { overflow-x: hidden }` means the page never scrolls sideways, so a
 * scroll-width check would pass while content sat unreachable off-screen. This
 * walks the rendered boxes instead and only forgives an element whose ancestor
 * chain contains a real horizontal scroller - which is the contract the wide
 * tables and charts are written to.
 */
export async function findOverflow(page: Page, tolerance = 1): Promise<Overflow[]> {
  return page.evaluate((slack) => {
    const limit = document.documentElement.clientWidth;
    const describe = (element: Element): string => {
      const classes = Array.from(element.classList).slice(0, 3).join(".");
      const id = element.id ? `#${element.id}` : "";
      return `${element.tagName.toLowerCase()}${id}${classes ? `.${classes}` : ""}`;
    };
    const offenders: { selector: string; right: number; left: number; limit: number }[] = [];
    for (const element of Array.from(document.body.querySelectorAll("*"))) {
      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
        continue;
      }
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.right <= limit + slack && rect.left >= -slack) continue;
      let ancestor = element.parentElement;
      let clipped = false;
      while (ancestor && ancestor !== document.body) {
        const overflowX = window.getComputedStyle(ancestor).overflowX;
        if (overflowX === "auto" || overflowX === "scroll" || overflowX === "hidden") {
          clipped = true;
          break;
        }
        ancestor = ancestor.parentElement;
      }
      if (clipped) continue;
      offenders.push({
        selector: describe(element),
        right: Math.round(rect.right),
        left: Math.round(rect.left),
        limit,
      });
    }
    return offenders;
  }, tolerance);
}

/** Nothing may sit outside the viewport unless it scrolls in its own box. */
export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const offenders = await findOverflow(page);
  expect(offenders, `elements overflow the viewport: ${JSON.stringify(offenders)}`).toEqual([]);
}

/** A control a person has to hit with a finger or a cursor during the demo. */
export async function expectHitTarget(
  locator: Locator,
  minSize: number,
  label: string,
): Promise<void> {
  await expect(locator, `${label} is not visible`).toBeVisible();
  const box = await ensureBox(locator);
  expect(box.height, `${label} is only ${box.height}px tall`).toBeGreaterThanOrEqual(minSize);
  expect(box.width, `${label} is only ${box.width}px wide`).toBeGreaterThanOrEqual(minSize);
}

/** A control must also be reachable: fully inside the viewport's width. */
export async function expectWithinViewport(
  page: Page,
  locator: Locator,
  label: string,
): Promise<void> {
  const box = await ensureBox(locator);
  const width = await page.evaluate(() => document.documentElement.clientWidth);
  expect(box.x, `${label} starts left of the viewport`).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width, `${label} reaches past the viewport`).toBeLessThanOrEqual(width + 1);
}

/** A wide table must scroll inside `.table-scroll`, never widen the page. */
export async function expectTableScrollsInItsOwnBox(
  page: Page,
  scroller: Locator,
  label: string,
): Promise<void> {
  await expect(scroller, `${label} is missing`).toBeVisible();
  const metrics = await scroller.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    overflowX: window.getComputedStyle(element).overflowX,
  }));
  const viewport = await page.evaluate(() => document.documentElement.clientWidth);
  expect(metrics.overflowX, `${label} does not scroll horizontally`).toMatch(/auto|scroll/);
  expect(metrics.clientWidth, `${label} is wider than the viewport`).toBeLessThanOrEqual(viewport);
}

/** Text that has been cut off rather than wrapped or scrolled. */
export async function expectNoClippedText(page: Page, root: string): Promise<void> {
  const clipped = await page.evaluate((selector) => {
    const container = document.querySelector(selector);
    if (!container) return [];
    const offenders: { selector: string; scrollWidth: number; clientWidth: number }[] = [];
    for (const element of Array.from(container.querySelectorAll("*"))) {
      const style = window.getComputedStyle(element);
      if (style.overflowX !== "hidden") continue;
      if (style.textOverflow === "ellipsis") continue;
      if (element.clientWidth === 0) continue;
      if (element.scrollWidth <= element.clientWidth + 1) continue;
      const classes = Array.from(element.classList).slice(0, 3).join(".");
      offenders.push({
        selector: `${element.tagName.toLowerCase()}${classes ? `.${classes}` : ""}`,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      });
    }
    return offenders;
  }, root);
  expect(clipped, `text is clipped: ${JSON.stringify(clipped)}`).toEqual([]);
}

/**
 * A parcel id is the identifier a reviewer copies out of the demo, and it is
 * one token. The results table's auto layout will happily squeeze the column to
 * its hyphens and stack the id several lines deep unless the chip refuses to
 * wrap.
 */
export async function expectParcelIdOnOneLine(scope: Locator, label: string): Promise<void> {
  const chip = scope.locator(".parcel-chip").first();
  await expect(chip, `${label} has no parcel id chip`).toBeVisible();
  const box = await ensureBox(chip);
  expect(box.height, `${label}: the parcel id wrapped onto several lines`).toBeLessThanOrEqual(26);
  expect(box.width, `${label}: the parcel id is not rendered in full`).toBeGreaterThan(100);
}
