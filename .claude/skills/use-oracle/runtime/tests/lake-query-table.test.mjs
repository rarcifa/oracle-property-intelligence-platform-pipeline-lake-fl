import { describe, expect, it } from "vitest";
import { lakeEnrichmentProfile } from "../src/counties/lake/enrichment-profile.mjs";
import {
  assertQueryTableColumns,
  buildEnrichmentStatus,
  buildInCountyCitySet,
  buildSourceSystems,
  deriveRoofAge,
  LAKE_QUERY_TABLE_SCHEMA_FIELDS,
  lakePropertyId,
  mapJoinedRecordToQueryTableRow,
  parseOwnerNames,
  toPlausibleYear,
  toSaleDate,
} from "../src/counties/lake/query-table.mjs";

const NAL_ROW = Object.freeze({
  PARCEL_ID: "32-18-24-0250-000-01400",
  ALT_KEY: "3404921",
  DOR_UC: "001",
  JV: "318622",
  AV_NSD: "250000",
  LND_VAL: "60000",
  TV_NSD: "200000",
  LND_SQFOOT: "43560",
  ACT_YR_BLT: "1992",
  TOT_LVG_AREA: "1800",
  NO_BULDNG: "1",
  PHY_ADDR1: "36828 TAYLOR MILL RD",
  PHY_CITY: "FRUITLAND PARK",
  PHY_ZIPCD: "34731",
  OWN_NAME: "MASON JEANNE M & MASON ROBERT",
  OWN_CITY: "SCOTTSDALE",
  OWN_STATE: "AZ",
  OWN_ZIPCD: "85251",
  SALE_YR1: "2025",
  SALE_MO1: "6",
  SALE_PRC1: "410000",
});

describe("property identity", () => {
  it("derives a stable 32-hex id that differs per parcel", () => {
    const id = lakePropertyId("32-18-24-0250-000-01400");
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(lakePropertyId("32-18-24-0250-000-01400")).toBe(id);
    expect(lakePropertyId("01-22-24-1500-063-00001")).not.toBe(id);
  });
});

describe("year and date coercion", () => {
  it("rejects implausible years rather than publishing them", () => {
    expect(toPlausibleYear("1992")).toBe(1992);
    expect(toPlausibleYear("0")).toBeNull();
    expect(toPlausibleYear("9999")).toBeNull();
    expect(toPlausibleYear("")).toBeNull();
  });

  it("builds a sale date from the roll's split year and month columns", () => {
    expect(toSaleDate("2025", "6")).toBe("2025-06-01");
    expect(toSaleDate("2025", "")).toBe("2025-01-01");
    expect(toSaleDate("2025", "13")).toBe("2025-01-01");
    expect(toSaleDate("", "6")).toBeNull();
  });
});

describe("roof age derivation", () => {
  const asOfYear = 2026;

  it("prefers a completed roofing permit over everything else", () => {
    const roof = deriveRoofAge({
      permits: [
        { is_roofing: true, co_date: "2020-05-04", issued_date: "2019-01-01" },
        { is_roofing: false, co_date: "2024-01-01", issued_date: "2024-01-01" },
      ],
      builtYear: "1992",
      asOfYear,
    });
    expect(roof).toEqual({ years: 6, basis: "roofing_permit_completed", lastPermitDate: "2020-05-04" });
  });

  it("falls back to the issue date when a roofing permit has not completed", () => {
    const roof = deriveRoofAge({
      permits: [{ is_roofing: true, co_date: null, issued_date: "2018-03-02" }],
      builtYear: "1992",
      asOfYear,
    });
    expect(roof).toEqual({ years: 8, basis: "roofing_permit_issued", lastPermitDate: "2018-03-02" });
  });

  it("falls back to year built when no roofing permit exists", () => {
    const roof = deriveRoofAge({ permits: [], builtYear: "1992", asOfYear });
    expect(roof).toEqual({ years: 34, basis: "year_built", lastPermitDate: null });
  });

  it("returns nothing rather than guessing when there is no evidence at all", () => {
    expect(deriveRoofAge({ permits: [], builtYear: "", asOfYear })).toEqual({
      years: null,
      basis: null,
      lastPermitDate: null,
    });
  });

  it("uses the most recent roofing permit when several exist", () => {
    const roof = deriveRoofAge({
      permits: [
        { is_roofing: true, co_date: "2015-01-01", issued_date: null },
        { is_roofing: true, co_date: "2021-09-09", issued_date: null },
      ],
      builtYear: "1980",
      asOfYear,
    });
    expect(roof.lastPermitDate).toBe("2021-09-09");
    expect(roof.years).toBe(5);
  });

  it("ignores non-roofing permits when dating the roof", () => {
    const roof = deriveRoofAge({
      permits: [{ is_roofing: false, co_date: "2025-01-01", issued_date: "2025-01-01" }],
      builtYear: "1992",
      asOfYear,
    });
    expect(roof.basis).toBe("year_built");
  });
});

describe("owner parsing and locality", () => {
  it("splits joint owners and keeps the original text", () => {
    expect(parseOwnerNames("MASON JEANNE M & MASON ROBERT")).toEqual({
      name: "MASON JEANNE M",
      owners: ["MASON JEANNE M", "MASON ROBERT"],
    });
    expect(parseOwnerNames("")).toEqual({ name: null, owners: [] });
  });

  it("builds the in-county city vocabulary from the roll itself", () => {
    const cities = buildInCountyCitySet(["Eustis", "TAVARES", "", "eustis"]);
    expect(cities.has("EUSTIS")).toBe(true);
    expect(cities.has("TAVARES")).toBe(true);
    expect(cities.size).toBe(2);
  });
});

describe("query-table row mapping", () => {
  const inCountyCities = buildInCountyCitySet(["FRUITLAND PARK", "EUSTIS"]);

  it("maps a parcel with an open roofing permit into the roofing columns", () => {
    const row = mapJoinedRecordToQueryTableRow({
      nal: NAL_ROW,
      centroid: { latitude: 28.86, longitude: -81.62 },
      permits: [
        { is_roofing: true, is_open: true, days_open: 2200, co_date: null, issued_date: "2020-06-01", applied_date: "2020-05-01" },
        { is_roofing: false, is_open: false, days_open: 30, co_date: "2024-02-01", issued_date: "2024-01-01", applied_date: "2024-01-01" },
      ],
      sales: [{}],
      businessAccountCount: 2,
      inCountyCities,
      asOfYear: 2026,
    });
    expect(row.request_identifier).toBe("32-18-24-0250-000-01400");
    expect(row.has_permits).toBe(true);
    expect(row.permit_count).toBe(2);
    expect(row.roofing_permit_count).toBe(1);
    expect(row.open_permit_count).toBe(1);
    expect(row.open_roofing_permit_count).toBe(1);
    expect(row.longest_open_permit_days).toBe(2200);
    expect(row.roof_age_basis).toBe("roofing_permit_issued");
    expect(row.roof_age_years).toBe(6);
    expect(row.latitude).toBe(28.86);
    expect(row.has_business_account).toBe(true);
    expect(row.business_account_count).toBe(2);
  });

  it("marks an out-of-county, out-of-state owner", () => {
    const row = mapJoinedRecordToQueryTableRow({ nal: NAL_ROW, inCountyCities });
    expect(row.owner_out_of_county).toBe(true);
    expect(row.owner_out_of_state).toBe(true);
    expect(row.owner_mailing_state).toBe("AZ");
  });

  it("marks an in-county Florida owner", () => {
    const row = mapJoinedRecordToQueryTableRow({
      nal: { ...NAL_ROW, OWN_CITY: "EUSTIS", OWN_STATE: "FL" },
      inCountyCities,
    });
    expect(row.owner_out_of_county).toBe(false);
    expect(row.owner_out_of_state).toBe(false);
  });

  it("never claims a tenure it cannot prove, and reports the lower bound instead", () => {
    const withSale = mapJoinedRecordToQueryTableRow({ nal: NAL_ROW, sales: [{}] });
    expect(withSale.last_sale_date).toBe("2025-06-01");
    expect(withSale.no_recorded_sale_in_dor_window).toBe(false);

    const withoutSale = mapJoinedRecordToQueryTableRow({
      nal: { ...NAL_ROW, SALE_YR1: "", SALE_MO1: "", SALE_PRC1: "" },
      sales: [],
    });
    expect(withoutSale.last_sale_date).toBeNull();
    expect(withoutSale.no_recorded_sale_in_dor_window).toBe(true);
  });

  it("publishes gated enrichment as null columns that say why", () => {
    const row = mapJoinedRecordToQueryTableRow({ nal: NAL_ROW, permits: [{ is_roofing: false, is_open: false }] });
    expect(row.contractor_name).toBeNull();
    expect(row.bbb_rating).toBeNull();
    // Null, not false: neither absence was ever established, so a boolean would
    // assert something no source checked. The test name has always said null.
    expect(row.has_bbb_contractor).toBeNull();
    expect(row.has_sunbiz_tenant).toBeNull();
    expect(row.enrichment_status).toContain("contractor_gated_403");
    expect(row.enrichment_status).toContain("bbb_gated_403");
  });

  it("names only the sources that actually contributed", () => {
    expect(buildSourceSystems({ nal: NAL_ROW })).toBe("fl_dor_nal_2026p");
    expect(
      buildSourceSystems({
        nal: NAL_ROW,
        centroid: { latitude: 1 },
        permits: [{}],
        sales: [{}],
        businessAccountCount: 1,
      }),
    ).toBe("fl_dor_nal_2026p|fl_gio_parcel_centroid_2025|lake_cdplus_permits|fl_dor_sdf_2026p|fl_dor_tpp_2026p");
  });

  it("states the enrichment status differently when no permits exist", () => {
    expect(buildEnrichmentStatus(false)).toContain("no_permits_in_source");
    expect(buildEnrichmentStatus(true)).toContain("permits_loaded");
  });

  it("emits exactly the declared schema columns", () => {
    const row = mapJoinedRecordToQueryTableRow({ nal: NAL_ROW });
    expect(Object.keys(row)).toEqual(Object.keys(LAKE_QUERY_TABLE_SCHEMA_FIELDS));
  });
});

describe("published column contract", () => {
  it("accepts the declared order and rejects drift", () => {
    const columns = Object.keys(LAKE_QUERY_TABLE_SCHEMA_FIELDS);
    expect(() => assertQueryTableColumns(columns)).not.toThrow();
    expect(() => assertQueryTableColumns(columns.slice(0, -1))).toThrow(/columns, expected/);
    const swapped = [...columns];
    [swapped[1], swapped[2]] = [swapped[2], swapped[1]];
    expect(() => assertQueryTableColumns(swapped)).toThrow(/column 1 is/);
  });

  it("matches the enrichment profile the kit validates", () => {
    expect(Object.keys(lakeEnrichmentProfile.queryTable.schemaFields)).toEqual(
      Object.keys(LAKE_QUERY_TABLE_SCHEMA_FIELDS),
    );
  });

  it("carries the six columns the kit's profile schema makes mandatory", () => {
    expect(LAKE_QUERY_TABLE_SCHEMA_FIELDS.property_id).toEqual({ type: "UTF8" });
    expect(LAKE_QUERY_TABLE_SCHEMA_FIELDS.address_street.type).toBe("UTF8");
    expect(LAKE_QUERY_TABLE_SCHEMA_FIELDS.address_zip.type).toBe("UTF8");
    expect(LAKE_QUERY_TABLE_SCHEMA_FIELDS.has_permits.type).toBe("BOOLEAN");
    expect(LAKE_QUERY_TABLE_SCHEMA_FIELDS.has_sunbiz_tenant.type).toBe("BOOLEAN");
    expect(LAKE_QUERY_TABLE_SCHEMA_FIELDS.has_bbb_contractor.type).toBe("BOOLEAN");
  });
});
