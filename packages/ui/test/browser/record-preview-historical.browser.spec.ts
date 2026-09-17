import { expect, test } from "@playwright/test";
import { assertHistoricalRowsDisplayed } from "../../scripts/record-preview-historical.mjs";

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
