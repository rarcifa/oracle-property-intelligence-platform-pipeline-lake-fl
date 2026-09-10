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
  expectHitTarget,
  expectNoClippedText,
  expectNoHorizontalOverflow,
  expectTableScrollsInItsOwnBox,
  expectWithinViewport,
  gotoView,
  mockPublishedRun,
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

    test("scrolls the verification table rather than the page", async ({ page }) => {
      const verification = page.locator(".table-scroll").first();
      await expectTableScrollsInItsOwnBox(page, verification, "gateway verification table");
      const box = await ensureBox(verification);
      expect(box.height, "the verification table collapsed").toBeGreaterThan(0);
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
