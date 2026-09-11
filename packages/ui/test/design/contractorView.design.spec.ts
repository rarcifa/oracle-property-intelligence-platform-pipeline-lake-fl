/**
 * Contractor design: the gating notices that lead the view, the two "queried,
 * not asserted" tiles, the permit-posture grid, the duration chart and its
 * key/value list, and the open-roofing parcel table.
 */

import { expect, test } from "@playwright/test";
import { BREAKPOINTS } from "./support/breakpoints.js";
import {
  ensureBox,
  expectNoClippedText,
  expectNoHorizontalOverflow,
  expectParcelIdOnOneLine,
  expectTableScrollsInItsOwnBox,
  expectWithinViewport,
  gotoView,
  mockPublishedRun,
  pinServerDataPath,
} from "./support/harness.js";
import { expectChartScrolls, expectTileGrid } from "./support/panels.js";
import { expectShellUsable } from "./support/shell.js";

for (const bp of BREAKPOINTS) {
  test.describe(`Contractor design - ${bp.name}`, () => {
    test.use({ viewport: bp.viewport });

    test.beforeEach(async ({ page }) => {
      await mockPublishedRun(page);
      await pinServerDataPath(page);
      await gotoView(page, "/contractor", ".notice.gated");
    });

    test("keeps the gating notices leading and legible", async ({ page }) => {
      await expectShellUsable(page, bp);
      const notices = page.locator(".notice.gated");
      await expect(notices.first()).toBeVisible();
      const count = await notices.count();
      expect(count, "the gating notices are the point of this view").toBeGreaterThan(0);
      for (let index = 0; index < count; index += 1) {
        await expectWithinViewport(page, notices.nth(index), `gating notice ${index + 1}`);
      }
      await expectNoClippedText(page, ".app-main");
    });

    test("reflows the proof tiles and the permit-posture grid", async ({ page }) => {
      const proofTiles = page.locator(".tile-grid").first();
      await expect(proofTiles).toBeVisible();
      await expect(proofTiles.locator(".tile-value").first()).toHaveCSS(
        "font-size",
        bp.tiles.valueSize,
      );
      await expectWithinViewport(page, proofTiles, "gating proof tiles");

      await expectTileGrid(bp, page.locator(".tile-grid").nth(1));
      await expect(page.getByText("Longest open permit (any type)", { exact: true })).toBeVisible();
      await expect(page.getByText("Longest open roofing permit", { exact: true })).toBeVisible();
      await expectNoHorizontalOverflow(page);
    });

    test("keeps the duration chart, its list and the table usable", async ({ page }) => {
      const roofingSortRequest = page.waitForRequest((request) => {
        const url = new URL(request.url());
        return (
          url.pathname === "/api/properties" &&
          url.searchParams.get("hasOpenRoofingPermit") === "true" &&
          url.searchParams.get("sortBy") === "longest_open_roofing_permit_days" &&
          url.searchParams.get("sortDir") === "desc"
        );
      });
      await page.reload();
      await roofingSortRequest;

      await expectChartScrolls(page, page.locator(".chart").first(), "open-permit duration chart");

      const kvList = page.locator(".kv-list").first();
      await expect(kvList).toBeVisible();
      const kvBox = await ensureBox(kvList);
      expect(kvBox.height, "the duration key/value list collapsed").toBeGreaterThan(0);
      await expectWithinViewport(page, kvList, "duration key/value list");

      await expectTableScrollsInItsOwnBox(page, page.locator(".table-scroll"), "contractor table");
      await expectParcelIdOnOneLine(page.locator(".table-scroll"), "contractor table");
      await expect(page.locator(".table-scroll tbody tr").first()).toContainText("3,424 d");
      await expect(
        page.getByText("Ordered by the longest open roofing permit duration, descending.", {
          exact: true,
        }),
      ).toBeVisible();
      await expectWithinViewport(page, page.locator(".table-foot"), "contractor pager");
      await expectNoHorizontalOverflow(page);
    });
  });
}
