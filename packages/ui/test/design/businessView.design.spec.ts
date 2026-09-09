/**
 * Business design: the TPP caveat, the totals tiles, the two concentration
 * charts and the parcel table.
 */

import { expect, test } from "@playwright/test";
import { BREAKPOINTS } from "./support/breakpoints.js";
import {
  expectNoClippedText,
  expectNoHorizontalOverflow,
  expectParcelIdOnOneLine,
  expectTableScrollsInItsOwnBox,
  expectWithinViewport,
  gotoView,
  mockPublishedRun,
  pinServerDataPath,
} from "./support/harness.js";
import { expectChartScrolls, expectTileGrid, expectTwoUpRow } from "./support/panels.js";
import { expectShellUsable } from "./support/shell.js";

for (const bp of BREAKPOINTS) {
  test.describe(`Business design - ${bp.name}`, () => {
    test.use({ viewport: bp.viewport });

    test.beforeEach(async ({ page }) => {
      await mockPublishedRun(page);
      await pinServerDataPath(page);
      await gotoView(page, "/business", ".tile-grid");
    });

    test("keeps the shell and the signal caveat readable", async ({ page }) => {
      await expectShellUsable(page, bp);
      await expect(page.locator(".notice.info")).toBeVisible();
      await expectWithinViewport(page, page.locator(".notice.info"), "TPP caveat");
      await expectNoClippedText(page, ".app-main");
    });

    test("reflows the totals tiles and both charts", async ({ page }) => {
      const tiles = page.locator(".tile-grid").first();
      await expectTileGrid(bp, tiles);
      await expectTwoUpRow(bp, page.locator(".grid-2").first());
      await expectChartScrolls(page, page.locator(".chart").first(), "TPP by city chart");
      await expectChartScrolls(page, page.locator(".chart").nth(1), "TPP by property type chart");
      await expectNoHorizontalOverflow(page);
    });

    test("keeps the parcel table in its own scroller", async ({ page }) => {
      await expectTableScrollsInItsOwnBox(page, page.locator(".table-scroll"), "business table");
      await expectParcelIdOnOneLine(page.locator(".table-scroll"), "business table");
      await expectWithinViewport(page, page.locator(".table-foot"), "business pager");
      await expectNoHorizontalOverflow(page);
    });
  });
}
