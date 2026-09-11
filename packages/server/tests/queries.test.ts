/**
 * Query-layer tests against the real published Parquet.
 *
 * These assert relationships rather than hardcoded totals — a filtered subset is
 * never larger than the whole, an aged-roof search returns only aged roofs — so
 * they stay true across re-publishes while still failing if the query layer
 * breaks.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_ROOF_AGE_THRESHOLD_YEARS, PROPERTIES_VIEW } from "@oracle-lake/shared";
import {
  getCityCentre,
  getBusinessView,
  getContractorView,
  getDatasetStats,
  getFacets,
  getProperty,
  searchProperties,
} from "../src/data/queries.js";
import type { ProvenanceContext } from "../src/data/queries.js";
import type { OracleDataStore } from "../src/data/duckdb.js";
import { closeStore, getStore, hasParquet } from "./harness.js";

const provenance: ProvenanceContext = {
  runId: "test",
  rootCid: null,
  dataSource: "test",
  dataSourceKind: "local",
};

/**
 * Rows the pipeline marked as carrying a contractor harvested from Clermont.
 *
 * `contractor_name` stopped being an always-null column when Clermont's
 * eTRAKiT portal was harvested, and the run this suite opens is whichever one
 * was published last. Asserting a literal count would therefore be either
 * stale or wrong, so the assertions below compare the published count against
 * the published tokens: the two have to agree whether the answer is 0, as it
 * is for every run published before the Clermont harvest lands, or the few
 * thousand Clermont parcels it will be afterwards.
 */
async function clermontContractorRows(store: OracleDataStore): Promise<number> {
  return Number(
    await store.queryScalar(
      `SELECT count(*) FROM ${PROPERTIES_VIEW} WHERE coalesce(enrichment_status, '') LIKE '%contractor_from_clermont_etrakit%'`,
    ),
  );
}

describe.skipIf(!hasParquet)("query layer over the published Parquet", () => {
  let store: OracleDataStore;
  let total = 0;

  beforeAll(async () => {
    store = await getStore();
    total = Number(await store.queryScalar(`SELECT count(*) FROM ${PROPERTIES_VIEW}`));
  });

  afterAll(() => {
    closeStore();
  });

  it("opens a table with rows and passes the 63-column schema gate", () => {
    // init() already ran assertSchemaMatches; reaching here means it passed.
    expect(total).toBeGreaterThan(100_000);
  });

  it("agrees with the coverage denominator", async () => {
    const stats = await getDatasetStats(store, provenance);
    expect(stats.stats.properties).toBe(total);
    expect(stats.stats.with_coordinates).toBeLessThanOrEqual(total);
    expect(stats.stats.roof_age_known).toBeLessThanOrEqual(total);
  });

  it("proves the gated column is empty rather than asserting it", async () => {
    const stats = await getDatasetStats(store, provenance);
    expect(stats.stats.bbb_ratings_present).toBe(0);
  });

  it("counts contractor names only where a source published one", async () => {
    const stats = await getDatasetStats(store, provenance);
    const contractors = stats.stats.contractor_names_present;
    // Every published contractor must be one the Clermont harvest produced,
    // and every Clermont-harvested contractor must be counted. Equality
    // catches both failures a bare `toBe(0)` cannot: a name that arrived
    // without a token to explain it, and a token claiming a name that is not
    // there. The count is 0 on runs published before the harvest landed.
    expect(contractors).toBe(await clermontContractorRows(store));
    const unexplained = Number(
      await store.queryScalar(
        `SELECT count(*) FROM ${PROPERTIES_VIEW}
         WHERE contractor_name IS NOT NULL
           AND coalesce(enrichment_status, '') NOT LIKE '%contractor_from_clermont_etrakit%'`,
      ),
    );
    expect(unexplained).toBe(0);
    // One jurisdiction of fifteen. If this ever approached the whole county,
    // the column would be claiming coverage no Lake source can supply.
    expect(contractors).toBeLessThan(total / 2);
  });

  it("returns a page no larger than the limit and a true matching total", async () => {
    const result = await searchProperties(store, provenance, { limit: 10 });
    expect(result.rows).toHaveLength(10);
    expect(result.matched).toBe(total);
  });

  it("narrows the matching total when a filter is applied", async () => {
    const aged = await searchProperties(store, provenance, {
      minRoofAge: DEFAULT_ROOF_AGE_THRESHOLD_YEARS,
      limit: 5,
    });
    expect(aged.matched).toBeGreaterThan(0);
    expect(aged.matched).toBeLessThan(total);
    for (const row of aged.rows) {
      expect(Number(row.roof_age_years)).toBeGreaterThanOrEqual(DEFAULT_ROOF_AGE_THRESHOLD_YEARS);
    }
  });

  it("returns only parcels with an open roofing permit when asked", async () => {
    const open = await searchProperties(store, provenance, {
      hasOpenRoofingPermit: true,
      limit: 20,
      sortBy: "longest_open_roofing_permit_days",
      sortDir: "desc",
    });
    expect(open.matched).toBeGreaterThan(0);
    for (const row of open.rows) {
      expect(Number(row.open_roofing_permit_count)).toBeGreaterThan(0);
    }
  });

  it("orders a radius search nearest first and stays inside the radius", async () => {
    // Centre on a real parcel so the radius is guaranteed to contain something.
    const seed = await searchProperties(store, provenance, {
      requireCoordinates: true,
      limit: 1,
    });
    const first = seed.rows[0];
    const lat = Number(first?.latitude);
    const lon = Number(first?.longitude);
    const result = await searchProperties(store, provenance, {
      lat,
      lon,
      radiusMiles: 2,
      limit: 25,
    });
    expect(result.rows.length).toBeGreaterThan(0);
    let previous = -1;
    for (const row of result.rows) {
      const distance = Number(row.distance_miles);
      expect(distance).toBeLessThanOrEqual(2);
      expect(distance).toBeGreaterThanOrEqual(previous);
      previous = distance;
    }
  });

  it("matches free text against the owner name", async () => {
    const seed = await searchProperties(store, provenance, { limit: 1 });
    const owner = String(seed.rows[0]?.owner_name ?? "");
    const token = owner.split(/\s+/)[0] ?? "";
    if (token.length < 3) return;
    const result = await searchProperties(store, provenance, { q: token, limit: 5 });
    expect(result.matched).toBeGreaterThan(0);
  });

  it("returns a property detail carrying its sources and gating reasons", async () => {
    const seed = await searchProperties(store, provenance, { hasPermits: true, limit: 1 });
    const parcelId = String(seed.rows[0]?.request_identifier);
    const detail = await getProperty(store, provenance, parcelId);
    expect(detail).not.toBeNull();
    expect(detail?.property.request_identifier).toBe(parcelId);
    expect(detail?.sources.length).toBeGreaterThan(0);
    // bbb_rating is gated on every row, so it is always a gating notice.
    // contractor_name is gated only where no source covering the parcel
    // publishes a contractor, so the expectation is read off this row rather
    // than hardcoded - the seed parcel is whichever one sorts first, and after
    // the Clermont harvest that may well be a parcel with a contractor on it.
    const status = String(detail?.property.enrichment_status ?? "");
    expect(detail?.gating.map((notice) => notice.field)).toEqual(
      status.includes("contractor_gated_403") ? ["contractor_name", "bbb_rating"] : ["bbb_rating"],
    );
    if (status.includes("contractor_from_clermont_etrakit")) {
      expect(detail?.property.contractor_name).not.toBeNull();
    } else {
      // Gated, or harvested from Clermont and named nobody. Either way the row
      // carries the reason, which is what stops the blank being read as proof.
      expect(detail?.property.contractor_name).toBeNull();
      expect(status).toMatch(/contractor_(gated_403|absent_on_permit)/);
    }
  });

  it("returns null for an unknown parcel rather than throwing", async () => {
    expect(await getProperty(store, provenance, "00-00-00-0000-000-00000")).toBeNull();
  });

  it("carries the executed SQL and the contributing source systems in provenance", async () => {
    const result = await searchProperties(store, provenance, { limit: 3 });
    expect(result.provenance.sql).toContain("FROM properties");
    expect(result.provenance.sourceSystems.length).toBeGreaterThan(0);
    expect(result.provenance.sourceSystems.join(" ")).toContain("DOR NAL");
  });

  it("produces facet lists for the filter rail", async () => {
    const facets = await getFacets(store);
    expect(facets.cities.length).toBeGreaterThan(1);
    expect(facets.propertyTypes.length).toBeGreaterThan(1);
    const bases = facets.roofAgeBasis.map((row) => String(row.value));
    expect(bases).toContain("year_built");
  });

  it("summarises the business view without inventing a Sunbiz signal", async () => {
    const view = await getBusinessView(store, provenance);
    expect(view.totals.properties_with_accounts).toBeGreaterThan(0);
    expect(view.totals.sunbiz_tenants).toBe(0);
    expect(view.byCity.length).toBeGreaterThan(0);
    expect(view.note).toContain("Sunbiz");
  });

  it("summarises the contractor view and names both gated fields", async () => {
    const view = await getContractorView(store, provenance);
    expect(view.posture.properties_with_permits).toBeGreaterThan(0);
    expect(view.posture.contractor_names_present).toBe(await clermontContractorRows(store));
    expect(view.posture.bbb_ratings_present).toBe(0);
    // The view has no row to read a status off, so it asks for the majority
    // case explicitly: both columns are gated for every parcel outside
    // Clermont, and the notices say so in the same words a row would.
    expect(view.gating).toHaveLength(2);
    for (const notice of view.gating) {
      expect(notice.detail).toContain("403");
    }
  });
});

describe.skipIf(!hasParquet)("getCityCentre", () => {
  it("returns the same centre on every call, which radius answers depend on", async () => {
    const store = await getStore();
    const context = provenance;
    const first = await getCityCentre(store, context, "Clermont");
    const second = await getCityCentre(store, context, "CLERMONT");
    expect(first.lat).not.toBeNull();
    expect(first.lat).toBe(second.lat);
    expect(first.lon).toBe(second.lon);
    expect(first.city).toBe("CLERMONT");
    expect(first.parcelsWithCoordinates).toBeGreaterThan(1000);
  }, 120_000);

  it("reports a place the roll does not carry as having no centre", async () => {
    const store = await getStore();
    const context = provenance;
    const result = await getCityCentre(store, context, "Orlando");
    expect(result.lat).toBeNull();
    expect(result.parcelsWithCoordinates).toBe(0);
  }, 120_000);
});

describe.skipIf(!hasParquet)("contractor view totals", () => {
  it("omits a date column rather than publishing it as 0", async () => {
    const store = await getStore();
    const view = await getContractorView(store, provenance);
    // `max(latest_permit_date)` is a date string. It used to be coerced with
    // Number(...) and floored to 0, so a number nothing measured sat beside the
    // real counts. Absent is honest; 0 is not.
    expect(view.posture.latest_permit_date).toBeUndefined();
    // A real count, published whatever it is. It agrees with the Clermont
    // tokens on the same rows, so neither a 0 nor a non-zero here is asserted.
    expect(view.posture.contractor_names_present).toBe(await clermontContractorRows(store));
    expect(view.posture.longest_open_permit_days).toBeGreaterThan(1825);
  }, 120_000);
});
