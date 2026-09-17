/* global getComputedStyle */
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
