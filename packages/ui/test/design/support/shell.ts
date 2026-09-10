/**
 * The app shell is on screen in every view, so its breakpoint behaviour is
 * asserted from one place and called by each view spec.
 */

import { expect, type Page } from "@playwright/test";
import type { Breakpoint } from "./breakpoints.js";
import { expectHitTarget, expectNoHorizontalOverflow, expectWithinViewport } from "./harness.js";

export async function expectShellUsable(page: Page, bp: Breakpoint): Promise<void> {
  const viewport = await page.evaluate(() => document.documentElement.clientWidth);

  // A sticky header that eats a third of a phone screen would leave the demo
  // scrolling a letterbox.
  const headerShare = await page.evaluate(() => {
    const header = document.querySelector(".app-header");
    if (!header) return 1;
    return header.getBoundingClientRect().height / window.innerHeight;
  });
  expect(headerShare, "the sticky header takes too much of the viewport").toBeLessThan(0.34);

  const main = page.locator("main.app-main");
  await expect(main).toHaveCSS("padding-left", bp.shell.mainPadding);
  await expect(main).toHaveCSS("padding-right", bp.shell.mainPadding);
  await expect(page.locator(".header-inner")).toHaveCSS("padding-left", bp.shell.headerPadding);

  // The seven tabs are allowed to be wider than a phone, but only inside their
  // own scroller: the nav itself must never widen the page.
  const tabs = page.locator("nav.tabs");
  const tabMetrics = await tabs.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    overflowX: window.getComputedStyle(element).overflowX,
  }));
  expect(tabMetrics.overflowX, "the tab bar must scroll in its own box").toMatch(/auto|scroll/);
  expect(tabMetrics.clientWidth, "the tab bar is wider than the viewport").toBeLessThanOrEqual(
    viewport,
  );
  if (bp.shell.tabsScroll) {
    expect(tabMetrics.scrollWidth, "the tab bar should need scrolling here").toBeGreaterThan(
      tabMetrics.clientWidth,
    );
  } else {
    expect(
      tabMetrics.scrollWidth,
      "the tab bar should fit without scrolling here",
    ).toBeLessThanOrEqual(tabMetrics.clientWidth + 1);
  }

  // Whichever view is open, its tab has to be the one you can see: the strip
  // scrolls, and a deep link on a phone can otherwise land with the active tab
  // parked off the end of it.
  const activeTab = await page.evaluate(() => {
    const strip = document.querySelector("nav.tabs")?.getBoundingClientRect();
    const active = document.querySelector('.tab[aria-current="page"]')?.getBoundingClientRect();
    if (!strip || !active) return null;
    return {
      overflowLeft: Math.round(strip.left - active.left),
      overflowRight: Math.round(active.right - strip.right),
    };
  });
  expect(activeTab, "there is no active tab").not.toBeNull();
  expect(
    activeTab?.overflowLeft ?? 0,
    "the active tab is scrolled off the left",
  ).toBeLessThanOrEqual(1);
  expect(
    activeTab?.overflowRight ?? 0,
    "the active tab is scrolled off the right",
  ).toBeLessThanOrEqual(1);

  await expectHitTarget(page.locator(".tab").first(), bp.minControlSize, "first tab");
  await expectHitTarget(page.locator('.tab[aria-current="page"]'), bp.minControlSize, "active tab");
  await expectHitTarget(page.locator(".mode-pill"), bp.minControlSize, "data-mode pill");
  await expectWithinViewport(page, page.locator(".mode-pill"), "data-mode pill");
  await expectWithinViewport(page, page.locator(".brand-title h1"), "product title");

  await expectNoHorizontalOverflow(page);
}
