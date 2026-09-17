import { expect, test } from "@playwright/test";
import {
  assertHistoricalRowsDisplayed,
  frameHistoricalTableStart,
} from "../../scripts/record-preview-historical.mjs";

// Synthetic rendering regression only. These are not real permits or release evidence.
const ROW = {
  permit_number: "SYNTHETIC-PERMIT",
  jurisdiction: "Synthetic jurisdiction",
  permit_status: "ISSUED",
  issued_date: "09/17/2026 raw source",
  permit_type: "ROOF/REROOF",
  permit_description: "Synthetic recorded work",
  contractor_name: "Synthetic source-listed contractor",
  bbb_rating: null,
};

test.beforeEach(async ({ page }) => {
  await page.setContent(`<main><table class="data"><tbody><tr>
    <td>${ROW.permit_number}<br>${ROW.jurisdiction}</td>
    <td>${ROW.permit_status}<br>${ROW.issued_date}</td>
    <td>${ROW.permit_type}</td><td>${ROW.permit_description}</td>
    <td>${ROW.contractor_name}<br>BBB: unknown</td>
    <td>valid unlinked</td><td>—</td>
  </tr></tbody></table></main>`);
});

test("checks actual compound cells instead of an impossible exact permit-only locator", async ({
  page,
}) => {
  expect(await page.getByText(ROW.permit_number, { exact: true }).count()).toBe(0);
  await expect(assertHistoricalRowsDisplayed(page, [ROW], 1000)).resolves.toEqual({
    renderedRowsVerified: 1,
    columnsVerified: 5,
  });
});

for (const field of [
  "permit_number",
  "jurisdiction",
  "permit_status",
  "issued_date",
  "permit_type",
  "contractor_name",
]) {
  test(`rejects a displayed ${field} mismatch`, async ({ page }) => {
    await expect(
      assertHistoricalRowsDisplayed(page, [{ ...ROW, [field]: "WRONG SOURCE VALUE" }], 150),
    ).rejects.toThrow("Displayed historical permit cells differ");
  });
}

test("rejects missing rendered rows and hidden table content", async ({ page }) => {
  await expect(assertHistoricalRowsDisplayed(page, [ROW, ROW], 150)).rejects.toThrow(
    "Displayed historical permit cells differ",
  );
  await page.locator("table").evaluate((table) => {
    table.style.display = "none";
  });
  await expect(assertHistoricalRowsDisplayed(page, [ROW], 150)).rejects.toThrow(
    "Displayed historical permit cells differ",
  );
  await page.locator("table").evaluate((table) => {
    table.style.display = "";
    table.style.opacity = "0";
  });
  await expect(assertHistoricalRowsDisplayed(page, [ROW], 150)).rejects.toThrow(
    "Displayed historical permit cells differ",
  );
});

for (const viewport of [
  { width: 320, height: 900 },
  { width: 375, height: 900 },
  { width: 768, height: 900 },
  { width: 1280, height: 800 },
  { width: 1536, height: 900 },
]) {
  test(`frames the table header and first verified sample at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.addStyleTag({
      content:
        "body{margin:0}.app-header{position:sticky;top:0;height:80px;background:white;z-index:2} td{height:100px} table{border-collapse:collapse;width:100%}",
    });
    await page.evaluate(() => {
      document.body.insertAdjacentHTML(
        "afterbegin",
        '<header class="app-header">Synthetic recorder framing fixture</header><div style="height:1200px"></div>',
      );
      const table = document.querySelector("table")!;
      table.insertAdjacentHTML(
        "afterbegin",
        "<thead><tr><th>Permit / jurisdiction</th><th>Status / source date</th><th>Type</th><th>Work</th><th>Contractor / BBB</th></tr></thead>",
      );
      const row = table.querySelector("tbody tr")!;
      for (let index = 1; index < 50; index++) row.parentElement!.append(row.cloneNode(true));
    });
    // The previous giant-table locator centers mid-table, hiding the first sample.
    await page.locator("main table").scrollIntoViewIfNeeded();
    await expect(page.locator("main table tbody tr").first()).not.toBeInViewport();
    await expect(frameHistoricalTableStart(page, ROW, 1000)).resolves.toEqual({
      firstPermitNumber: ROW.permit_number,
      tableHeaderInViewport: true,
      firstRowInViewport: true,
    });
    await expect(page.locator("main table thead")).toBeInViewport();
    await expect(page.locator("main table tbody tr").first()).toBeInViewport();
  });
}
