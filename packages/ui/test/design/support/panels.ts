/**
 * Assertions for the three repeated panel shapes - the stat-tile grid, the
 * hand-drawn bar charts and the two-up panel row - so each view spec states
 * only what is particular to it.
 */

import { expect, type Locator, type Page } from "@playwright/test";
import type { Breakpoint } from "./breakpoints.js";
import { ensureBox, gridColumnCount } from "./harness.js";

/** Tiles reflow to the width and never spill out of their own grid. */
export async function expectTileGrid(bp: Breakpoint, grid: Locator): Promise<void> {
  await expect(grid).toBeVisible();
  const columns = await gridColumnCount(grid);
  expect(columns, `tile grid has ${columns} columns at ${bp.name}`).toBeGreaterThanOrEqual(
    bp.tiles.columns.min,
  );
  expect(columns, `tile grid has ${columns} columns at ${bp.name}`).toBeLessThanOrEqual(
    bp.tiles.columns.max,
  );

  await expect(grid.locator(".tile-value").first()).toHaveCSS("font-size", bp.tiles.valueSize);

  const gridBox = await ensureBox(grid);
  const spills = await grid.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return Array.from(element.children)
      .map((child) => child.getBoundingClientRect())
      .filter((rect) => rect.right > bounds.right + 1 || rect.left < bounds.left - 1).length;
  });
  expect(spills, "tiles spill out of the tile grid").toBe(0);
  expect(gridBox.width, "the tile grid has no width").toBeGreaterThan(0);
}

/** A chart is allowed to be wider than a phone, inside its own scroller. */
export async function expectChartScrolls(page: Page, chart: Locator, label: string): Promise<void> {
  await expect(chart, `${label} is missing`).toBeVisible();
  const metrics = await chart.evaluate((element) => ({
    clientWidth: element.clientWidth,
    overflowX: window.getComputedStyle(element).overflowX,
  }));
  const viewport = await page.evaluate(() => document.documentElement.clientWidth);
  expect(metrics.overflowX, `${label} does not scroll in its own box`).toMatch(/auto|scroll/);
  expect(metrics.clientWidth, `${label} is wider than the viewport`).toBeLessThanOrEqual(viewport);
  const box = await ensureBox(chart);
  expect(box.height, `${label} has collapsed`).toBeGreaterThan(0);
}

/** The two-up rows collapse to a single column on a phone. */
export async function expectTwoUpRow(bp: Breakpoint, row: Locator): Promise<void> {
  await expect(row).toBeVisible();
  const columns = await gridColumnCount(row);
  expect(columns, `two-up row has ${columns} columns at ${bp.name}`).toBeGreaterThanOrEqual(
    bp.gridTwoColumns.min,
  );
  expect(columns, `two-up row has ${columns} columns at ${bp.name}`).toBeLessThanOrEqual(
    bp.gridTwoColumns.max,
  );
  const spills = await row.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return Array.from(element.children)
      .map((child) => child.getBoundingClientRect())
      .filter((rect) => rect.right > bounds.right + 1).length;
  });
  expect(spills, "a panel spills out of the two-up row").toBe(0);
}
