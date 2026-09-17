/**
 * Overview design: the published-run panel, the gateway verification table, the
 * coverage tiles and limitation cards, and the gateway list with its long URLs.
 *
 * This is the landing view, so it is the first thing an evaluator sees and the
 * one place where long identifiers (CIDs, IPNS names, gateway URLs) are most
 * likely to widen the page.
 */

import { expect, test } from "@playwright/test";
import { BREAKPOINTS } from "./support/breakpoints.js";
import {
  ensureBox,
  FIXTURES,
  expectHitTarget,
  expectNoClippedText,
  expectNoHorizontalOverflow,
  expectTableScrollsInItsOwnBox,
  expectWithinViewport,
  gotoView,
  mockPublishedRun,
  mockStandalonePublicationEvidence,
  pinServerDataPath,
} from "./support/harness.js";
import { expectChartScrolls, expectTileGrid, expectTwoUpRow } from "./support/panels.js";
import { expectShellUsable } from "./support/shell.js";

for (const bp of BREAKPOINTS) {
  test.describe(`Overview design - ${bp.name}`, () => {
    test.use({ viewport: bp.viewport });

    test.beforeEach(async ({ page }) => {
      await mockPublishedRun(page);
      await pinServerDataPath(page);
      await gotoView(page, "/overview", ".kv-list");
    });

    test("keeps the run panel's identifiers inside the page", async ({ page }) => {
      await expectShellUsable(page, bp);

      const runList = page.locator(".kv-list").first();
      await expectWithinViewport(page, runList, "published run list");
      const rows = runList.locator(".kv");
      const count = await rows.count();
      expect(count, "the run panel lists the published identifiers").toBeGreaterThan(4);
      for (let index = 0; index < count; index += 1) {
        await expectWithinViewport(page, rows.nth(index), `run row ${index + 1}`);
      }
      await expectNoClippedText(page, ".app-main");
      await expectNoHorizontalOverflow(page);
    });

    test("wraps standalone manifest and CAR evidence without clipping its scope notice", async ({
      page,
    }) => {
      await mockStandalonePublicationEvidence(page);
      await page.reload();
      await page.evaluate(() => document.fonts.ready);
      await expect(page.getByTitle(`sha256:${"a".repeat(64)}`, { exact: true })).toBeVisible();
      await expect(page.getByTitle(`sha256:${"b".repeat(64)}`, { exact: true })).toBeVisible();
      const runList = page.locator(".kv-list").first();
      await expectWithinViewport(page, runList, "standalone evidence identifiers");
      const notice = page
        .locator(".notice.gated")
        .filter({ hasText: "Recorded public gateway byte matches only" });
      await expect(notice).toBeVisible();
      await expectWithinViewport(page, notice, "standalone evidence scope notice");
      await expectNoClippedText(page, ".app-main");
      await expectNoHorizontalOverflow(page);
    });

    test("scrolls the verification table rather than the page", async ({ page }) => {
      const verification = page.locator(".table-scroll").first();
      await expectTableScrollsInItsOwnBox(page, verification, "gateway verification table");
      const box = await ensureBox(verification);
      expect(box.height, "the verification table collapsed").toBeGreaterThan(0);
      await expectNoHorizontalOverflow(page);
    });

    test("keeps per-table incremental history inside its own horizontal scroller", async ({
      page,
    }) => {
      // Synthetic layout fixture only; not a publication or incremental-run proof.
      await page.route(/\/api\/meta\/run$/, (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ...FIXTURES.run,
            runHistory: {
              schemaVersion: "synthetic-design-history",
              runs: [
                {
                  runId: "SYNTHETIC_INCREMENTAL_HISTORY",
                  mode: "incremental",
                  rootCid: "not-a-public-history-cid-design-fixture",
                  tables: [
                    { name: "properties", rows: 215806, inserted: 0, updated: 0 },
                    { name: "permits", rows: 76431, inserted: 265, updated: 801 },
                  ],
                },
              ],
            },
          }),
        }),
      );
      await page.reload();
      await page.evaluate(() => document.fonts.ready);
      const panel = page.locator(".panel").filter({
        has: page.getByRole("heading", { name: "Run history", exact: true }),
      });
      const scroller = panel.locator(".table-scroll");
      await expectWithinViewport(page, scroller, "per-table history scroller");
      await expectTableScrollsInItsOwnBox(page, scroller, "per-table incremental history");
      await expect(panel.getByRole("columnheader", { name: "Table", exact: true })).toBeVisible();
      await expect(panel.getByRole("cell", { name: "permits", exact: true })).toBeVisible();
      await expectNoHorizontalOverflow(page);
    });

    test("keeps the finalized-publication scope notice readable without widening the page", async ({
      page,
    }) => {
      await mockStandalonePublicationEvidence(page, true);
      await page.reload();
      await page.evaluate(() => document.fonts.ready);
      const notice = page.locator(".notice.gated").filter({
        hasText: "Finalized publication receipts bind this snapshot",
      });
      await expect(notice).toBeVisible();
      await expectWithinViewport(page, notice, "finalized publication scope notice");
      await expectNoClippedText(page, ".app-main");
      await expectNoHorizontalOverflow(page);
    });

    test("reflows the coverage tiles, limitations and roof-age chart", async ({ page }) => {
      await expectTileGrid(bp, page.locator(".tile-grid").first());
      await expectHitTarget(
        page.getByRole("button", { name: "Re-run" }),
        bp.minControlSize,
        "re-run button",
      );

      const limitations = page.locator(".limitation-grid");
      await expect(limitations).toBeVisible();
      const cards = limitations.locator(".limitation-card");
      expect(await cards.count(), "coverage limitations are published verbatim").toBeGreaterThan(0);
      await expectWithinViewport(page, cards.first(), "first limitation card");

      await expectChartScrolls(page, page.locator(".chart").first(), "roof-age band chart");
      await expectNoHorizontalOverflow(page);
    });

    test("keeps the coverage and gateway panels inside the viewport", async ({ page }) => {
      await expectTwoUpRow(bp, page.locator(".grid-2").first());

      const gatewayRows = page.locator(".gateway-row");
      const count = await gatewayRows.count();
      expect(count, "the published gateways are listed").toBeGreaterThan(0);
      for (let index = 0; index < count; index += 1) {
        const row = gatewayRows.nth(index);
        await expectWithinViewport(page, row, `gateway row ${index + 1}`);
        await expectWithinViewport(page, row.locator("a").first(), `gateway url ${index + 1}`);
      }
      await expectNoHorizontalOverflow(page);
    });
  });
}
