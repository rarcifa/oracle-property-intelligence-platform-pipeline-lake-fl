/* global getComputedStyle, innerHeight */
/** Actual ContractorView cells, not fabricated visible samples or current-status inference. */
export function historicalRowCells(row) {
  const normalized = (value) => String(value).replace(/\s+/g, " ").trim();
  return [
    normalized(`${row.permit_number ?? "—"}\n${row.jurisdiction ?? "—"}`),
    normalized(`${row.permit_status ?? "unknown"}\n${row.issued_date ?? "unknown"}`),
    normalized(row.permit_type ?? "unknown"),
    normalized(row.permit_description ?? "—"),
    normalized(
      `${row.contractor_name ?? "not captured; absence unproven"}\nBBB: ${row.bbb_rating ?? "unknown"}`,
    ),
  ];
}

export async function assertHistoricalRowsDisplayed(page, rows, timeout = 30000) {
  if (!Array.isArray(rows) || rows.length === 0)
    throw new Error("Historical visible-row verification requires actual query rows");
  const expected = rows.map(historicalRowCells);
  try {
    await page.waitForFunction(
      (expected) => {
        const rendered = [...document.querySelectorAll("main table.data tbody tr")];
        return (
          rendered.length === expected.length &&
          rendered.every((row, index) => {
            const box = row.getBoundingClientRect();
            const cells = [...row.querySelectorAll("td")];
            let opacity = 1;
            for (let ancestor = row; ancestor; ancestor = ancestor.parentElement)
              opacity *= Number(getComputedStyle(ancestor).opacity);
            return (
              box.width > 0 &&
              box.height > 0 &&
              opacity > 0.02 &&
              getComputedStyle(row).visibility === "visible" &&
              expected[index].every(
                (value, column) => cells[column]?.innerText.replace(/\s+/g, " ").trim() === value,
              )
            );
          })
        );
      },
      expected,
      { timeout },
    );
  } catch (error) {
    throw new Error("Displayed historical permit cells differ from independently replayed rows", {
      cause: error,
    });
  }
  return { renderedRowsVerified: expected.length, columnsVerified: expected[0].length };
}

/** Frame the first real sample, not the middle of an arbitrarily tall table. */
export async function frameHistoricalTableStart(page, firstRow, timeout = 30000) {
  const expected = historicalRowCells(firstRow);
  await page.locator("main table.data tbody tr").first().scrollIntoViewIfNeeded();
  await page.waitForFunction(
    (expected) => {
      const heading = document.querySelector("main table.data thead");
      const row = document.querySelector("main table.data tbody tr");
      if (!heading || !row) return false;
      const top = document.querySelector(".app-header")?.getBoundingClientRect().bottom ?? 0;
      return (
        [heading, row].every((element) => {
          const box = element.getBoundingClientRect();
          return box.width > 0 && box.height > 0 && box.top >= top && box.bottom <= innerHeight;
        }) &&
        expected.every(
          (value, column) =>
            row.querySelectorAll("td")[column]?.innerText.replace(/\s+/g, " ").trim() === value,
        )
      );
    },
    expected,
    { timeout },
  );
  return {
    firstPermitNumber: String(firstRow.permit_number ?? "—"),
    tableHeaderInViewport: true,
    firstRowInViewport: true,
  };
}
