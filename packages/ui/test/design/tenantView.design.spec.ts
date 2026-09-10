/**
 * Tenant design: the tenure caveat, the owner-posture tiles, the two-up charts
 * and the pre-filtered parcel table with its inline toggles.
 */

import { expect, test } from "@playwright/test";
import { BREAKPOINTS } from "./support/breakpoints.js";
import {
  expectHitTarget,
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
  test.describe(`Tenant design - ${bp.name}`, () => {
    test.use({ viewport: bp.viewport });

    test.beforeEach(async ({ page }) => {
      await mockPublishedRun(page);
      await pinServerDataPath(page);
      await gotoView(page, "/tenant", ".tile-grid");
    });

    test("keeps the shell and the caveat readable", async ({ page }) => {
      await expectShellUsable(page, bp);
      const caveat = page.locator(".notice.info");
      await expect(caveat).toBeVisible();
      await expectWithinViewport(page, caveat, "tenure caveat");
      await expectNoClippedText(page, ".app-main");
    });

    test("reflows the owner-posture tiles and the charts", async ({ page }) => {
      await expectTileGrid(bp, page.locator(".tile-grid").first());
      await expectTwoUpRow(bp, page.locator(".grid-2").first());
      await expectChartScrolls(page, page.locator(".chart").first(), "owner mailing-state chart");
      await expectChartScrolls(page, page.locator(".chart").nth(1), "roof-age band chart");
      await expectNoHorizontalOverflow(page);
    });

    test("keeps the parcel filters and the table usable", async ({ page }) => {
      const actions = page.locator(".panel-head .row").last();
      await expect(actions).toBeVisible();
      await expect(actions).toHaveCSS("flex-wrap", "wrap");
      await expectWithinViewport(page, actions, "tenant filter row");

      for (const label of ["Owner out of state", "No sale in DOR window"]) {
        const toggle = page.locator(".toggle", { hasText: label }).first();
        await expectHitTarget(toggle, bp.minControlSize, `toggle "${label}"`);
        await expectWithinViewport(page, toggle, `toggle "${label}"`);
      }

      const roofAge = page.getByLabel("Minimum roof age in years");
      await expectHitTarget(roofAge, bp.minControlSize, "minimum roof age input");
      await expectWithinViewport(page, roofAge, "minimum roof age input");

      await expectTableScrollsInItsOwnBox(page, page.locator(".table-scroll"), "tenant table");
      await expectParcelIdOnOneLine(page.locator(".table-scroll"), "tenant table");
      await expectWithinViewport(page, page.locator(".table-foot"), "tenant pager");
      await expectNoHorizontalOverflow(page);
    });
  });
}
