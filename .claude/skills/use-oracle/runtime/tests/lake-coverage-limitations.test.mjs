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

/** Measured from the Clermont eTRAKiT harvest, permit year 26. */
const clermont = {
  permits: 4078,
  parcels: 2634,
  permits_with_contractor: 3651,
  distinct_contractors: 1204,
  distinct_licenses: 988,
  linked_parcels: 2589,
  roll_parcels: 215806,
  permit_years: "26",
  dead_permits: 54,
};

describe("published limitations", () => {
  it("covers every source boundary the dataset has", () => {
    const limitations = buildLimitations(linkage, business, clermont);
    expect(limitations).toHaveLength(9);
    for (const limitation of limitations) expect(limitation.trim().length).toBeGreaterThan(80);
  });

  it("declares the business coverage gap and the double count in figures", () => {
    const stated = buildLimitations(linkage, business, clermont).find((entry) =>
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
    const changed = buildLimitations(
      linkage,
      { ...business, matched_accounts: 3000, attributed_accounts: 6000 },
      clermont,
    ).find((entry) => entry.startsWith("Business coverage"));
    expect(changed).toContain("3000 match a parcel (9.0%)");
    expect(changed).toContain("yields 6000 rather than 3000");
  });

  it("keeps valid unlinked permits stated rather than dropped", () => {
    const permits = buildLimitations(linkage, business, clermont).find((entry) =>
      entry.includes("absent from the assessed roll"),
    );
    expect(permits).toContain("214 of 17671 permits");
  });
});

describe("contractor coverage is stated as partial, never as gated everywhere", () => {
  it("names the one jurisdiction that publishes a contractor and the figures behind it", () => {
    const stated = buildLimitations(linkage, business, clermont).find((entry) =>
      entry.startsWith("Contractor of record"),
    );
    expect(stated).toBeDefined();
    expect(stated).toContain("ONE jurisdiction of fifteen");
    expect(stated).toContain("4078 permits over 2634 parcel keys");
    expect(stated).toContain("3651 of them naming a contractor");
    expect(stated).toContain("1204 distinct businesses");
    // The three enrichment_status tokens have to be discoverable from the
    // coverage snapshot alone, or a consumer reading a null cannot tell which
    // of them it is.
    expect(stated).toContain("contractor_from_clermont_etrakit");
    expect(stated).toContain("contractor_absent_on_permit");
    expect(stated).toContain("contractor_gated_403");
  });

  it("states the share of the county Clermont actually covers, and does not round it up", () => {
    const stated = buildLimitations(linkage, business, clermont).find((entry) =>
      entry.startsWith("Clermont's permits cover"),
    );
    expect(stated).toBeDefined();
    // 2,589 of 215,806 is 1.2%, and the sentence has to say so rather than
    // leaving "Clermont is covered" to be read as county coverage.
    expect(stated).toContain("2589 parcels, 1.2% of the 215806-parcel roll");
    expect(stated).toContain("only permit year 26");
    expect(stated).toContain("54 enumerated permits are filed against no parcel key");
    expect(stated).toContain("is not a parcel with no permits");
  });

  it("recomputes the contractor figures per run rather than hardcoding them", () => {
    const changed = buildLimitations(linkage, business, {
      ...clermont,
      permits_with_contractor: 10,
      distinct_contractors: 4,
      linked_parcels: 21580,
    });
    const contractor = changed.find((entry) => entry.startsWith("Contractor of record"));
    expect(contractor).toContain("10 of them naming a contractor");
    expect(contractor).toContain("4 distinct businesses");
    expect(changed.find((entry) => entry.startsWith("Clermont's permits cover"))).toContain(
      "21580 parcels, 10.0% of the",
    );
  });
});
