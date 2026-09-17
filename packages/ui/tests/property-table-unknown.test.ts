import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PropertyTable } from "../src/components/PropertyTable.js";

function table(row: Record<string, unknown>): string {
  return renderToStaticMarkup(
    createElement(PropertyTable, {
      rows: [{ request_identifier: "synthetic-folio", ...row }],
      loading: false,
      onOpen: () => undefined,
    }),
  );
}

describe("property table unknown observations", () => {
  it("does not convert an unaccepted NULL open-roofing decision to zero", () => {
    const html = table({ permit_count: 1, open_roofing_permit_count: null });
    expect(html).toContain('<td class="num"><span class="dim">unknown</span></td>');
    expect(html).not.toContain('<span class="dim">0</span>');
  });

  it("distinguishes a real zero from missing observations", () => {
    expect(table({ open_roofing_permit_count: 0 })).toContain('<span class="dim">0</span>');
    expect(table({})).toContain('<span class="dim">unknown</span>');
    expect(table({ permit_count: null })).toContain('<td class="num">—</td>');
  });

  it("still displays an explicit nonzero decision and its known duration", () => {
    const html = table({ open_roofing_permit_count: 2, longest_open_roofing_permit_days: 1825 });
    expect(html).toContain("2 open · 1,825 d");
  });
});
