/** Cross-table invariants for the open-roofing lead signal. */
import { afterAll, describe, expect, it } from "vitest";
import { closeStore, getStore, hasParquet } from "./harness.js";

describe.skipIf(!hasParquet)("open-roofing signal invariants", () => {
  afterAll(() => {
    closeStore();
  });

  it("publishes no roofing duration without an open roofing permit", async () => {
    const store = await getStore();
    const violations = Number(
      await store.queryScalar(`SELECT count(*) FROM properties
WHERE coalesce(open_roofing_permit_count, 0) = 0
  AND coalesce(longest_open_roofing_permit_days, 0) <> 0`),
    );
    expect(violations).toBe(0);
  });

  it("never makes the roofing duration longer than the any-type duration", async () => {
    const store = await getStore();
    const violations = Number(
      await store.queryScalar(`SELECT count(*) FROM properties
WHERE coalesce(longest_open_roofing_permit_days, 0)
    > coalesce(longest_open_permit_days, 0)`),
    );
    expect(violations).toBe(0);
  });

  it("backs every five-year roofing lead with an open roofing record at that duration", async () => {
    const store = await getStore();
    // Legacy public runs predate permit-table.parquet; their property signal is
    // still queryable, but record-grain evidence can only be asserted once that
    // sibling artifact exists.
    if (!store.permitsAvailable) return;

    const leads = Number(
      await store.queryScalar(`SELECT count(*) FROM properties
WHERE coalesce(longest_open_roofing_permit_days, 0) >= 1825`),
    );
    const missingEvidence = Number(
      await store.queryScalar(`SELECT count(*)
FROM properties p
WHERE coalesce(p.longest_open_roofing_permit_days, 0) >= 1825
  AND NOT EXISTS (
    SELECT 1 FROM permits evidence
    WHERE evidence.parcel_identifier = p.request_identifier
      AND coalesce(evidence.is_roofing, FALSE)
      AND coalesce(evidence.is_open, FALSE)
      AND evidence.days_open = p.longest_open_roofing_permit_days
  )`),
    );
    expect(leads).toBeGreaterThan(0);
    expect(missingEvidence).toBe(0);
  });
});
