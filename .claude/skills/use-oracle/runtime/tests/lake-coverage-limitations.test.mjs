/**
 * The limitations published inside every run's coverage snapshot.
 *
 * The snapshot is the machine-readable record a consumer reads; prose in the
 * README is not. A limitation that exists only in the README is undisclosed as
 * far as any API, MCP tool or agent is concerned, so each one is asserted here
 * against the measurements it is derived from.
 */
import { describe, expect, it } from "vitest";

import { buildLimitations } from "../scripts/lake/build-publish-set.mjs";

/** Measured against the 2026 preliminary roll on 2026-09-10. */
const linkage = {
  total_permits: 17671,
  linked_permits: 17457,
  valid_unlinked_permits: 214,
  unmatched_parcel_keys: 119,
};

const business = {
  total_accounts: 33346,
  accounts_with_situs: 32738,
  matched_accounts: 2060,
  attributed_accounts: 4451,
  parcels_with_account: 2726,
  shared_address_groups: 90,
};

describe("published limitations", () => {
  it("covers every source boundary the dataset has", () => {
    const limitations = buildLimitations(linkage, business);
    expect(limitations).toHaveLength(8);
    for (const limitation of limitations) expect(limitation.trim().length).toBeGreaterThan(80);
  });

  it("declares the business coverage gap and the double count in figures", () => {
    const stated = buildLimitations(linkage, business).find((entry) =>
      entry.startsWith("Business coverage"),
    );
    expect(stated).toBeDefined();
    // The gap: 2,060 of 33,346 accounts match a parcel, so 93.8% are unpublished.
    expect(stated).toContain("32738 of 33346 accounts carry a situs address");
    expect(stated).toContain("2060 match a parcel (6.2%)");
    // The double count: 4,451 counts account-parcel matches, not businesses.
    expect(stated).toContain("yields 4451 rather than 2060");
    expect(stated).toContain("90 address groups span more than one parcel");
    expect(stated).toContain("not businesses");
  });

  it("recomputes the business figures per run rather than hardcoding them", () => {
    const changed = buildLimitations(linkage, {
      ...business,
      matched_accounts: 3000,
      attributed_accounts: 6000,
    }).find((entry) => entry.startsWith("Business coverage"));
    expect(changed).toContain("3000 match a parcel (9.0%)");
    expect(changed).toContain("yields 6000 rather than 3000");
  });

  it("keeps valid unlinked permits stated rather than dropped", () => {
    const permits = buildLimitations(linkage, business).find((entry) =>
      entry.includes("absent from the assessed roll"),
    );
    expect(permits).toContain("214 of 17671 permits");
  });
});
