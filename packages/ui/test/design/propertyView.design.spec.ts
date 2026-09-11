/** Property-detail design: linked permit evidence stays readable at every breakpoint. */
import { expect, test } from "@playwright/test";
import { BREAKPOINTS } from "./support/breakpoints.js";
import {
  expectNoClippedText,
  expectNoHorizontalOverflow,
  expectTableScrollsInItsOwnBox,
  expectWithinViewport,
  gotoView,
  mockPublishedRun,
  pinServerDataPath,
} from "./support/harness.js";
import { expectShellUsable } from "./support/shell.js";

const PARCEL_ID = "09-20-26-0100-000-02300";

for (const bp of BREAKPOINTS) {
  test.describe(`Property detail design - ${bp.name}`, () => {
    test.use({ viewport: bp.viewport });

    test.beforeEach(async ({ page }) => {
      await mockPublishedRun(page);
      await pinServerDataPath(page);
      await gotoView(page, `/property/${PARCEL_ID}`, "table.data");
    });

    test("keeps the permit-grain evidence visible and source-backed", async ({ page }) => {
      await expectShellUsable(page, bp);
      const panel = page.locator("section.panel").filter({
        has: page.getByRole("heading", { name: "Permit records", exact: true }),
      });
      await expect(panel).toBeVisible();
      await expect(panel.getByText("1 linked source record", { exact: true })).toBeVisible();

      const evidence = panel.locator("tbody tr").first();
      await expect(evidence).toContainText("2017030092");
      await expect(evidence).toContainText("ROOF-REROOF (OLD)");
      await expect(evidence).toContainText("roofing");
      await expect(evidence).toContainText("open");
      await expect(evidence).toContainText("3,426 days (9.39 yr)");
      await expect(evidence.getByRole("link", { name: "source record" })).toHaveAttribute(
        "href",
        /number=2017030092$/,
      );

      await expectWithinViewport(page, panel, "permit evidence panel");
      await expectNoClippedText(page, ".app-main");
    });

    test("keeps the wide permit evidence in its own scroller", async ({ page }) => {
      const panel = page.locator("section.panel").filter({
        has: page.getByRole("heading", { name: "Permit records", exact: true }),
      });
      await expectTableScrollsInItsOwnBox(
        page,
        panel.locator(".table-scroll"),
        "permit evidence table",
      );
      await expectNoHorizontalOverflow(page);
    });
  });
}
