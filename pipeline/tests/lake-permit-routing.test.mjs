import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  clermontPermitLoadRow,
  estimateHarvestDuration,
  sizeClermontStrategies,
  summarizeLatencies,
  CLERMONT_OPEN_STATUSES,
  CLERMONT_PERMIT_LOAD_COLUMNS,
  CLERMONT_TERMINATED_STATUSES,
  FEASIBILITY_GATE_HOURS,
} from "../src/counties/lake/clermont-permits.mjs";
import { createEtrakitAdapter, normalizeEtrakitParcelSearchValue } from "../src/counties/lake/etrakit-adapter.mjs";
import {
  dispatchableJurisdictions,
  groupParcelsByJurisdiction,
  routeLakeParcel,
  LAKE_PERMIT_JURISDICTIONS,
} from "../src/counties/lake/permit-routing.mjs";
import { createPermitAdapter, implementedPermitAdapterKeys } from "../src/permits/adapters/index.mjs";

/**
 * @param {string} name - Fixture file name.
 * @returns {string} Fixture HTML.
 */
function fixture(name) {
  return readFileSync(fileURLToPath(new URL(`./fixtures/lake-clermont/${name}`, import.meta.url)), "utf8");
}

/**
 * Read the catalog's `permits.jurisdictions` rows without a YAML dependency the
 * runtime does not ship. The catalog is written by this repository to a fixed
 * shape, and only five scalar fields are read, so a block scan is enough — and
 * a shape change makes the assertions below fail loudly rather than pass
 * vacuously, which is the point of reading the file at all.
 *
 * @returns {{ key: string, vendor: string, status: string, adapter: string, historical_records: string }[]}
 *   One row per catalogued jurisdiction.
 */
function catalogJurisdictions() {
  const yaml = readFileSync(
    fileURLToPath(new URL("../docs/lake-sources.yaml", import.meta.url)),
    "utf8",
  );
  const permitsBlock = yaml.slice(yaml.indexOf("\npermits:"), yaml.indexOf("\nbusiness:"));
  return permitsBlock
    .split(/^ {4}- jurisdiction: /m)
    .slice(1)
    .map((block) => {
      /**
       * @param {string} field - Field name.
       * @returns {string} Field value, or the empty string when absent.
       */
      const read = (field) => new RegExp(`^ {6}${field}: (.*)$`, "m").exec(block)?.[1]?.trim() ?? "";
      return {
        key: read("key"),
        vendor: read("vendor"),
        status: read("status"),
        adapter: read("adapter"),
        historical_records: read("historical_records"),
      };
    });
}

/**
 * @param {number} status - HTTP status.
 * @param {string} body - Response body.
 * @returns {{ ok: boolean, status: number, text: () => Promise<string> }} Response double.
 */
function response(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

describe("routing table and source catalog", () => {
  it("reads the catalog and proves the table is a projection of it, not a second copy", () => {
    const catalog = catalogJurisdictions();
    expect(catalog).toHaveLength(15);
    expect(LAKE_PERMIT_JURISDICTIONS).toHaveLength(catalog.length);

    for (const row of catalog) {
      const routed = LAKE_PERMIT_JURISDICTIONS.find((jurisdiction) => jurisdiction.key === row.key);
      expect(routed, `catalog jurisdiction ${row.key} is missing from the routing table`).toBeDefined();
      expect(routed.status).toBe(row.status);
      expect(routed.vendor).toBe(row.vendor);
      expect(routed.historicalRecords).toBe(row.historical_records === "true");
      // `adapter: none` in the catalog and a null adapter key in the table are
      // the same statement; anything else must match by name.
      expect(routed.adapterKey ?? "none").toBe(row.adapter === "cdplus" ? "none" : row.adapter);
    }
  });

  it("keeps exactly one default jurisdiction and unique city aliases", () => {
    const defaults = LAKE_PERMIT_JURISDICTIONS.filter((jurisdiction) => jurisdiction.defaultForUnmatchedCity);
    expect(defaults.map((jurisdiction) => jurisdiction.key)).toEqual(["unincorporated"]);
    const aliases = LAKE_PERMIT_JURISDICTIONS.flatMap((jurisdiction) => jurisdiction.routingCities);
    expect(new Set(aliases).size).toBe(aliases.length);
  });

  it("dispatches only to a supported jurisdiction with a registered vendor module", () => {
    expect(dispatchableJurisdictions().map((jurisdiction) => jurisdiction.key)).toEqual(["clermont"]);
    // The county layer is supported and harvested, but by a whole-layer bulk
    // walk rather than one request per parcel, so it is deliberately not a
    // parcel-keyed dispatch target.
    const county = LAKE_PERMIT_JURISDICTIONS.find((jurisdiction) => jurisdiction.key === "unincorporated");
    expect(county.status).toBe("supported");
    expect(county.harvestMode).toBe("bulk-export");
  });
});

describe("parcel routing", () => {
  it("routes a municipal city to its own jurisdiction", () => {
    expect(routeLakeParcel("Clermont").key).toBe("clermont");
    expect(routeLakeParcel("MOUNT DORA").key).toBe("mount-dora");
    expect(routeLakeParcel("Howey-in-the-Hills").key).toBe("howey-in-the-hills");
  });

  it("sends an unincorporated community to the county, which is where its permits are", () => {
    for (const city of ["SORRENTO", "PAISLEY", "ASTOR", "GRAND ISLAND", "YALAHA"]) {
      expect(routeLakeParcel(city).key).toBe("unincorporated");
    }
  });

  it("records a blank city as unrouted instead of defaulting it", () => {
    expect(routeLakeParcel("")).toBeNull();
    expect(routeLakeParcel(null)).toBeNull();
    const { byJurisdiction, unrouted } = groupParcelsByJurisdiction([
      { parcelIdentifier: "1017505", city: "CLERMONT" },
      { parcelIdentifier: "1614058", city: "clermont" },
      { parcelIdentifier: "9999999", city: "" },
      { parcelIdentifier: "1234567", city: "SORRENTO" },
    ]);
    expect(byJurisdiction.get("clermont").parcels).toEqual(["1017505", "1614058"]);
    expect(byJurisdiction.get("unincorporated").parcels).toEqual(["1234567"]);
    expect(unrouted).toEqual(["9999999"]);
  });
});

describe("etrakit vendor module", () => {
  it("is registered under the adapter key the permit profile has always admitted", () => {
    expect(implementedPermitAdapterKeys).toContain("etrakit");
    const adapter = createPermitAdapter({ adapterKey: "etrakit", adapterConfig: null });
    expect(adapter.key).toBe("etrakit");
  });

  it("strips punctuation off a parcel identifier and refuses one with no digits", () => {
    expect(normalizeEtrakitParcelSearchValue("1,017-505")).toBe("1017505");
    expect(() => normalizeEtrakitParcelSearchValue("  ")).toThrow(/Invalid eTRAKiT parcel identifier/);
  });

  it("searches a parcel, captures detail and binds the record to the requested property", async () => {
    const calls = [];
    const adapter = createEtrakitAdapter(
      { adapterKey: "etrakit", adapterConfig: null },
      {
        maxAttempts: 1,
        fetchImpl: async (url, init) => {
          calls.push({ url, method: init?.method ?? "GET" });
          if (init?.method === "POST") return response(200, fixture("permit-search-results-parcel.html"));
          if (String(url).includes("activityNo=")) {
            return response(200, fixture("permit-detail-with-contractor.html"));
          }
          return response(200, fixture("permit-search-bootstrap.html"));
        },
      },
    );

    // One search returns the parcel's whole permit history, 2022 to 2026, which
    // is the reason a parcel-keyed pass needs no year loop of its own.
    const references = await adapter.searchParcel("3,925-114");
    expect(references.map((reference) => reference.permitNumber)).toEqual([
      "22-1705",
      "23-2462",
      "25-4361",
      "26-3563",
      "26-3627",
    ]);
    expect(references[0].sourceRecordId).toBeTruthy();
    expect(references.every((reference) => reference.sourceUrl.startsWith("https://"))).toBe(true);

    const propertyId = "a".repeat(32);
    const record = await adapter.fetchPermitDetail(references.at(-1), {
      requestedParcelIdentifier: "3925114",
      requestedPropertyId: propertyId,
    });
    expect(record.property_id).toBe(propertyId);
    expect(record.parcel_identifier).toBe("3925114");
    expect(record.jurisdictionKey).toBe("clermont");
    expect(record.source_system).toBe("lake_clermont_etrakit_permits");
  });

  it("returns no references for a parcel the portal does not know, rather than failing", async () => {
    const adapter = createEtrakitAdapter(
      { adapterKey: "etrakit", adapterConfig: null },
      {
        maxAttempts: 1,
        fetchImpl: async (_url, init) =>
          response(200, init?.method === "POST" ? fixture("permit-search-no-results.html") : fixture("permit-search-bootstrap.html")),
      },
    );
    await expect(adapter.searchParcel("9999999")).resolves.toEqual([]);
  });

  it("classifies a portal that accepts the connection and never answers as transient", async () => {
    // The observed outage: TCP accepted, no HTTP response, so fetch aborts on
    // its own timeout. `county-ingest-run` section 5 puts that in RETRYABLE,
    // and a harvester that recorded it as a permit with no contractor would
    // under-report coverage permanently.
    const adapter = createEtrakitAdapter(
      { adapterKey: "etrakit", adapterConfig: null },
      {
        maxAttempts: 1,
        fetchImpl: async () => {
          throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
        },
      },
    );
    await expect(adapter.searchParcel("3925114")).rejects.toMatchObject({
      classification: "transient",
      code: "request_timeout",
    });
  });
});

describe("throughput estimation", () => {
  it("summarizes latency samples and reports nothing for an empty sample", () => {
    expect(summarizeLatencies([])).toEqual({
      count: 0,
      p50Ms: null,
      p95Ms: null,
      meanMs: null,
      minMs: null,
      maxMs: null,
    });
    const summary = summarizeLatencies([100, 200, 300, 400]);
    expect(summary).toMatchObject({ count: 4, p50Ms: 300, minMs: 100, maxMs: 400, meanMs: 250 });
  });

  it("charges retry overhead against the measured failure rate", () => {
    const clean = estimateHarvestDuration({ requests: 1000, latencyMs: 1000, concurrency: 2 });
    expect(clean.seconds).toBe(500);
    const lossy = estimateHarvestDuration({
      requests: 1000,
      latencyMs: 1000,
      concurrency: 2,
      failureRate: 0.1,
      retryAttemptsPerFailure: 1,
    });
    expect(lossy.effectiveRequests).toBe(1100);
    expect(lossy.seconds).toBe(550);
  });

  it("flags an estimate past the 48-hour gate instead of scaling into it", () => {
    const long = estimateHarvestDuration({ requests: 1_000_000, latencyMs: 1000, concurrency: 2 });
    expect(long.hours).toBeGreaterThan(FEASIBILITY_GATE_HOURS);
    expect(long.withinGate).toBe(false);
  });

  it("rejects inputs that would silently produce a meaningless estimate", () => {
    expect(() => estimateHarvestDuration({ requests: 1, latencyMs: 0, concurrency: 1 })).toThrow(/latencyMs/);
    expect(() => estimateHarvestDuration({ requests: 1, latencyMs: 1, concurrency: 0 })).toThrow(/concurrency/);
    expect(() => estimateHarvestDuration({ requests: -1, latencyMs: 1, concurrency: 1 })).toThrow(/requests/);
  });

  it("sizes the two strategies the portal admits, in requests", () => {
    const sized = sizeClermontStrategies({ candidateParcels: 50447, permitCount: 4132, prefixesSearched: 490 });
    expect(sized.parcelKeyed.requests).toBe(54579);
    expect(sized.enumerated.requests).toBe(4622);
    // The whole argument for enumerating: the same detail pages, an eleventh
    // of the searches.
    expect(sized.parcelKeyed.searches / sized.enumerated.searches).toBeGreaterThan(100);
  });
});

describe("permit-load row projection", () => {
  /**
   * @param {object} overrides - Fields to override.
   * @returns {object} A normalized-record shaped stub.
   */
  const record = (overrides) => ({
    permit_number: "26-0002",
    parcel_identifier: "3839288",
    improvement_type: "ROOF/REROOF",
    improvement_status: "FINALED",
    project_description: "RE-ROOF REMOVE AND REPLACE SHINGLES",
    description: "RE-ROOF REMOVE AND REPLACE SHI...",
    application_received_date: "2026-01-02",
    permit_issue_date: "2026-01-06",
    permit_close_date: "2026-02-10",
    final_inspection_date: "2026-02-10",
    sourceUrl: "https://etrakit.clermontfl.org/eTRAKiT3/Search/permit.aspx?activityNo=26-0002",
    isRoofPermit: true,
    source_system: "lake_clermont_etrakit_permits",
    sourcePayload: { contractorOfRecord: "A ROOFING CO", contractorOfRecordLicense: "CCC1335680", approvedDate: "2026-01-05" },
    ...overrides,
  });

  it("carries the county slug prefix the permit-table export filters on", () => {
    expect(clermontPermitLoadRow(record({})).source_system.startsWith("lake_")).toBe(true);
  });

  it("closes a finaled permit and measures the days it was open from its own dates", () => {
    const row = clermontPermitLoadRow(record({}));
    expect(row.is_open).toBe(false);
    expect(row.days_open).toBe(35);
    expect(row.co_date).toBe("2026-02-10");
    expect(row.contractor_name).toBe("A ROOFING CO");
    expect(row.contractor_license).toBe("CCC1335680");
  });

  it("measures an open permit against the clock, not against a close date it does not have", () => {
    const row = clermontPermitLoadRow(
      record({ improvement_status: "ISSUED", permit_close_date: null, final_inspection_date: null }),
      { nowMs: Date.parse("2026-09-11T00:00:00Z") },
    );
    expect(row.is_open).toBe(true);
    expect(row.days_open).toBe(248);
    expect(row.co_date).toBeNull();
  });

  it("treats a terminated permit as closed, and an unseen status as not open", () => {
    for (const status of ["VOID", "EXPIRED", "REJECTED", "SOME NEW STATUS"]) {
      expect(clermontPermitLoadRow(record({ improvement_status: status })).is_open).toBe(false);
    }
    // Every status the harvest has actually seen is classified on purpose, so a
    // new one is the only thing that can fall through to the conservative default.
    for (const status of CLERMONT_OPEN_STATUSES) {
      expect(clermontPermitLoadRow(record({ improvement_status: status })).is_open).toBe(true);
    }
    for (const status of CLERMONT_TERMINATED_STATUSES) {
      expect(clermontPermitLoadRow(record({ improvement_status: status })).is_open).toBe(false);
    }
  });

  it("uses the county permit layer's own column names so the two sources aggregate as one", () => {
    // These are read_csv_auto's column names in scripts/lake/build-query-table.sql;
    // a rename here silently drops a column from the union.
    expect(CLERMONT_PERMIT_LOAD_COLUMNS).toEqual([
      "permit_number",
      "alternate_key",
      "parcel_id",
      "permit_type",
      "permit_desc",
      "permit_status",
      "applied_date",
      "approved_date",
      "issued_date",
      "co_date",
      "last_modified",
      "permit_url",
      "is_roofing",
      "is_open",
      "days_open",
      "source_system",
      "contractor_name",
      "contractor_license",
    ]);
  });
});
