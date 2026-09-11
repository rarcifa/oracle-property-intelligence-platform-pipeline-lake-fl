/**
 * Search design: the filter rail, the radius controls, the roof-age slider,
 * the map panel and the results table, across the breakpoint matrix.
 *
 * This view carries both of the stylesheet's media queries, so it is where a
 * laptop-width regression would show up first.
 */

import { expect, test } from "@playwright/test";
import { BREAKPOINTS } from "./support/breakpoints.js";
import {
  ensureBox,
  expectHitTarget,
  expectNoClippedText,
  expectNoHorizontalOverflow,
  expectParcelIdOnOneLine,
  expectTableScrollsInItsOwnBox,
  expectWithinViewport,
  gotoView,
  gridColumnCount,
  mockPublishedRun,
  pinServerDataPath,
} from "./support/harness.js";

for (const bp of BREAKPOINTS) {
  test.describe(`Search design - ${bp.name}`, () => {
    test.use({ viewport: bp.viewport });

    test.beforeEach(async ({ page }) => {
      await mockPublishedRun(page);
      await pinServerDataPath(page);
      await gotoView(page, "/search", ".search-layout");
    });

    test("lays the rail and results out for this width", async ({ page }) => {
      const layout = page.locator(".search-layout");
      const columns = await gridColumnCount(layout);
      const rail = page.locator(".filter-rail");
      const railToggle = page.locator(".rail-toggle");

      if (bp.search.layout === "rail") {
        expect(columns, "the rail layout is two columns above 1080px").toBe(2);
        const track = await layout.evaluate(
          (element) => window.getComputedStyle(element).gridTemplateColumns.split(" ")[0],
        );
        expect(track).toBe("300px");
        await expect(railToggle).toBeHidden();
      } else {
        expect(columns, "the rail stacks below 1080px").toBe(1);
        await expect(railToggle).toBeVisible();
        await expectHitTarget(railToggle, bp.minControlSize, "filter rail toggle");
      }

      await expect(rail).toBeVisible();
      await expectWithinViewport(page, rail, "filter rail");
      await expectNoClippedText(page, ".filter-rail");
      await expectNoHorizontalOverflow(page);
    });

    test("keeps every radius and roof-age control reachable", async ({ page }) => {
      const pair = page.locator(".filter-rail .pair").first();
      expect(await gridColumnCount(pair)).toBe(bp.search.pairColumns);

      // Paired controls are one row: their labels must start on the same line.
      const pairs = page.locator(".filter-rail .pair");
      const pairCount = await pairs.count();
      expect(pairCount, "the rail pairs its numeric controls").toBeGreaterThan(0);
      for (let index = 0; index < pairCount; index += 1) {
        const tops = await pairs
          .nth(index)
          .evaluate((element) =>
            Array.from(element.children).map((child) =>
              Math.round(child.getBoundingClientRect().top),
            ),
          );
        expect(tops.length, `pair ${index + 1} holds two fields`).toBe(2);
        if (bp.search.pairColumns === 2) {
          expect(
            Math.abs((tops[1] ?? 0) - (tops[0] ?? 0)),
            `pair ${index + 1} is misaligned side to side`,
          ).toBeLessThanOrEqual(1);
        } else {
          expect(tops[1] ?? 0, `pair ${index + 1} should stack here`).toBeGreaterThan(tops[0] ?? 0);
        }
      }

      const slider = page.locator("#filter-roof-range");
      await expectWithinViewport(page, slider, "roof-age slider");
      const sliderBox = await ensureBox(slider);
      expect(sliderBox.width, "the roof-age slider is too narrow to drag").toBeGreaterThan(80);
      expect(sliderBox.height, "the roof-age slider is too thin to grab").toBeGreaterThanOrEqual(
        bp.minControlSize,
      );

      for (const id of [
        "#filter-lat",
        "#filter-lon",
        "#filter-radius",
        "#filter-roof-number",
        "#filter-min-open-roofing-days",
      ]) {
        const control = page.locator(id);
        await expectHitTarget(control, bp.minControlSize, `control ${id}`);
        await expectWithinViewport(page, control, `control ${id}`);
      }

      const clearRadius = page.getByRole("button", { name: "Clear radius" });
      await expectHitTarget(clearRadius, bp.minControlSize, "clear radius button");
      await expectWithinViewport(page, clearRadius, "clear radius button");

      const roofingHelp = page.locator("#filter-min-open-roofing-days-help");
      await expect(roofingHelp).toContainText("longest open roofing permit");
      await expectWithinViewport(page, roofingHelp, "roofing-duration explanation");
    });

    test("couples the roofing-duration control to the roofing signal", async ({ page }) => {
      const duration = page.locator("#filter-min-open-roofing-days");
      const openRoofing = page.getByRole("checkbox", { name: "Open roofing permit" });
      const filteredRequest = page.waitForRequest((request) => {
        const url = new URL(request.url());
        return (
          url.pathname === "/api/properties" &&
          url.searchParams.get("hasOpenRoofingPermit") === "true" &&
          url.searchParams.get("minOpenRoofingPermitDays") === "1825"
        );
      });

      await duration.fill("1825");
      await expect(duration).toHaveValue("1825");
      await expect(openRoofing).toBeChecked();
      await filteredRequest;

      await openRoofing.uncheck();
      await expect(openRoofing).not.toBeChecked();
      await expect(duration).toHaveValue("");
      await expectNoHorizontalOverflow(page);
    });

    test("gives the map real height and the results their own scroller", async ({ page }) => {
      const shell = page.locator(".map-shell");
      await expect(shell).toBeVisible();
      const shellBox = await ensureBox(shell);
      expect(Math.round(shellBox.height), "the map panel collapsed").toBe(bp.search.mapHeight);
      const canvasHost = page.locator(".map-shell > div").first();
      const hostBox = await ensureBox(canvasHost);
      expect(hostBox.height, "the map's own container has no height").toBeGreaterThan(0);
      await expectWithinViewport(page, shell, "map panel");

      await expectTableScrollsInItsOwnBox(page, page.locator(".table-scroll"), "results table");
      await expectParcelIdOnOneLine(page.locator(".table-scroll"), "results table");
      await expectHitTarget(
        page.getByRole("button", { name: "Next →" }),
        bp.minControlSize,
        "pager next",
      );
      await expectWithinViewport(page, page.locator(".table-foot"), "pager row");
      await expectNoHorizontalOverflow(page);
    });

    if (bp.search.layout === "rail") {
      test("pins the sticky rail below the sticky header", async ({ page }) => {
        const rail = page.locator(".filter-rail");
        await expect(rail).toHaveCSS("position", "sticky");

        await page.evaluate(() => window.scrollTo(0, 800));
        await expect
          .poll(async () =>
            page.evaluate(() =>
              Math.round(document.querySelector(".filter-rail")!.getBoundingClientRect().top),
            ),
          )
          .toBeLessThan(200);

        const geometry = await page.evaluate(() => {
          const header = document.querySelector(".app-header")!.getBoundingClientRect();
          const railRect = document.querySelector(".filter-rail")!.getBoundingClientRect();
          return {
            headerBottom: Math.round(header.bottom),
            railTop: Math.round(railRect.top),
            railBottom: Math.round(railRect.bottom),
            viewportHeight: window.innerHeight,
          };
        });

        expect(
          geometry.railTop,
          "the pinned rail slides under the sticky header",
        ).toBeGreaterThanOrEqual(geometry.headerBottom);
        expect(
          geometry.railTop,
          "the pinned rail floats too far below the header",
        ).toBeLessThanOrEqual(geometry.headerBottom + 24);
        expect(
          geometry.railBottom,
          "the pinned rail runs off the bottom of the screen",
        ).toBeLessThanOrEqual(geometry.viewportHeight);
      });
    }

    if (bp.search.railToggleVisible) {
      test("collapses and restores the rail without breaking the layout", async ({ page }) => {
        const rail = page.locator(".filter-rail");
        const railToggle = page.locator(".rail-toggle");

        await railToggle.click();
        await expect(rail).toBeHidden();
        await expectNoHorizontalOverflow(page);

        await railToggle.click();
        await expect(rail).toBeVisible();
        await expectWithinViewport(page, rail, "restored filter rail");
        await expectNoHorizontalOverflow(page);
      });
    }
  });
}
