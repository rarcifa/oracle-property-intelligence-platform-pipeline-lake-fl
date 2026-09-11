import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildContractorLicenseIndex,
  buildPermitSearchBody,
  contractorMatchKey,
  createClermontPermitSession,
  expandPermitPrefix,
  licenseFromName,
  normalizeClermontPermit,
  parseAspNetFormState,
  parseContractorLicenseDirectory,
  parsePermitDetailHtml,
  parsePermitSearchResults,
  permitDetailUrl,
  permitYearPrefixes,
  selectContractorOfRecord,
  walkPermitPrefixes,
  SEARCH_FIELDS,
  SEARCH_OPERATORS,
} from "../src/counties/lake/clermont-permits.mjs";

/**
 * @param {string} name - Fixture file name.
 * @returns {string} Fixture HTML.
 */
function fixture(name) {
  return readFileSync(fileURLToPath(new URL(`./fixtures/lake-clermont/${name}`, import.meta.url)), "utf8");
}

const BOOTSTRAP = fixture("permit-search-bootstrap.html");
const CAPPED = fixture("permit-search-results-capped.html");
const PARCEL = fixture("permit-search-results-parcel.html");
const NO_RESULTS = fixture("permit-search-no-results.html");
const DETAIL_POOL = fixture("permit-detail-with-contractor.html");
const DETAIL_ROOF = fixture("permit-detail-roofing.html");
const DETAIL_PARTIAL = fixture("permit-detail-partial-render.html");

/**
 * @param {number} status - HTTP status.
 * @param {string} body - Response body.
 * @returns {{ ok: boolean, status: number, text: () => Promise<string> }} Response double.
 */
function response(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

describe("ASP.NET form round-trip", () => {
  it("reads the hidden form state the search postback has to echo back", () => {
    const state = parseAspNetFormState(BOOTSTRAP);
    expect(state.__VIEWSTATE).toBe("TRUNCATED_VIEWSTATE_FOR_FIXTURE");
    expect(state.__VIEWSTATEGENERATOR).toBe("C310722E");
  });

  it("fails closed rather than posting a search with no viewstate", () => {
    expect(() => parseAspNetFormState("<html><body>no form</body></html>")).toThrow(/no __VIEWSTATE/);
  });

  it("builds a search body that keeps the viewstate and drops the contractor login select", () => {
    const body = buildPermitSearchBody(parseAspNetFormState(BOOTSTRAP), {
      searchBy: SEARCH_FIELDS.alternateKey,
      operator: SEARCH_OPERATORS.equals,
      value: "3925114",
    });
    expect(body.get("__VIEWSTATE")).toBe("TRUNCATED_VIEWSTATE_FOR_FIXTURE");
    expect(body.get("__EVENTTARGET")).toBe("ctl00$cplMain$btnSearch");
    expect(body.get("ctl00$cplMain$ddSearchBy")).toBe("Permit_Main.SITE_APN");
    expect(body.get("ctl00$cplMain$ddSearchOper")).toBe("EQUALS");
    expect(body.get("ctl00$cplMain$txtSearchString")).toBe("3925114");
    expect(body.get("ctl00$ucLogin$ddlSelLogin")).toBe("Public");
    expect(body.has("ctl00$ucLogin$ddlSelContractor")).toBe(false);
  });
});

describe("search result parsing", () => {
  it("reads a parcel's whole permit history off a single page", () => {
    const result = parsePermitSearchResults(PARCEL);
    expect(result.noResults).toBe(false);
    expect(result.capped).toBe(false);
    expect(result.pageCount).toBe(1);
    expect(result.rows).toHaveLength(5);
    expect(result.rows[0]).toEqual({
      permitNumber: "22-1705",
      issuedDate: "2022-04-22",
      permitType: "SINGLE FAMILY DETACHED PP2",
      alternateKey: "3925114",
      siteAddress: "2171 TIMBER CREEK LN",
      siteStreetName: "TIMBER CREEK LN",
      description: "New Single Family Home Lot 21 ...",
      recordId: "ECON:220412041604751",
    });
    expect(result.rows.every((row) => row.alternateKey === "3925114")).toBe(true);
  });

  it("flags a capped result set instead of pretending page 1 is the whole answer", () => {
    const result = parsePermitSearchResults(CAPPED);
    expect(result.rows).toHaveLength(20);
    expect(result.pageCount).toBe(5);
    expect(result.capped).toBe(true);
  });

  it("treats the portal's no-results notice as an empty answer, not a failure", () => {
    const result = parsePermitSearchResults(NO_RESULTS);
    expect(result.noResults).toBe(true);
    expect(result.rows).toEqual([]);
    expect(result.capped).toBe(false);
  });

  it("refuses a response that is neither results nor a no-results notice", () => {
    expect(() => parsePermitSearchResults("<html><body>maintenance</body></html>")).toThrow(
      /neither results nor a no-results notice/,
    );
  });
});

describe("permit detail parsing", () => {
  it("extracts the contractor of record, the subs and the inspections", () => {
    const detail = parsePermitDetailHtml(DETAIL_POOL, { expectedPermitNumber: "26-3627" });
    expect(detail.permitNumber).toBe("26-3627");
    expect(detail.permitType).toBe("RESIDENTIAL POOL");
    expect(detail.status).toBe("ISSUED");
    expect(detail.alternateKey).toBe("3925114");
    expect(detail.appliedDate).toBe("2026-08-10");
    expect(detail.issuedDate).toBe("2026-09-01");
    expect(detail.expirationDate).toBe("2027-03-02");
    expect(detail.contacts.map((contact) => contact.role)).toEqual([
      "APPLICANT",
      "CONTRACTOR",
      "OWNER",
      "EL SUB",
    ]);
    expect(selectContractorOfRecord(detail.contacts)).toEqual(
      expect.objectContaining({ role: "CONTRACTOR", name: "BOWLES CUSTOM POOLS & SPAS INC" }),
    );
    expect(detail.inspections[0]).toEqual({
      inspectionType: "NOTICE OF COMMENCEME",
      sequence: "10",
      result: "APPROVED",
      requestedDate: "2026-09-03",
      inspectionDate: "2026-09-03",
    });
  });

  it("parses a record whose controls carry a different ctl index", () => {
    // eTRAKiT renumbers detail controls per record: this permit renders as
    // cplMain_ctl11_* where the pool permit renders as cplMain_ctl09_*.
    expect(DETAIL_ROOF).toContain("cplMain_ctl11_lblPermitType");
    expect(DETAIL_POOL).toContain("cplMain_ctl09_lblPermitType");
    const detail = parsePermitDetailHtml(DETAIL_ROOF, { expectedPermitNumber: "24-0009" });
    expect(detail.permitType).toBe("ROOF/REROOF");
    expect(detail.status).toBe("FINALED");
    expect(detail.finaledDate).toBe("2024-03-12");
    expect(detail.alternateKey).toBe("3597940");
    expect(selectContractorOfRecord(detail.contacts)?.name).toBe("WEST ORANGE ROOFING (CCC)");
  });

  it("treats a chrome-only partial render as retryable, never as 'no contractor'", () => {
    expect(() => parsePermitDetailHtml(DETAIL_PARTIAL, { expectedPermitNumber: "24-0006" })).toThrow(
      /no permit record/,
    );
    try {
      parsePermitDetailHtml(DETAIL_PARTIAL, { expectedPermitNumber: "24-0006" });
    } catch (error) {
      expect(error.classification).toBe("transient");
      expect(error.code).toBe("etrakit_detail_partial_render");
    }
  });

  it("rejects a detail page that describes a different permit", () => {
    expect(() => parsePermitDetailHtml(DETAIL_POOL, { expectedPermitNumber: "26-9999" })).toThrow(
      /served permit 26-3627 for requested permit 26-9999/,
    );
  });

  it("builds an https detail URL", () => {
    expect(permitDetailUrl("26-3627")).toBe(
      "https://etrakit.clermontfl.org/eTRAKiT3/Search/permit.aspx?activityNo=26-3627",
    );
  });
});

describe("contractor licence resolution", () => {
  it("reads the registered-contractor directory eTRAKiT renders inline", () => {
    const entries = parseContractorLicenseDirectory(BOOTSTRAP);
    expect(entries).toContainEqual({ name: "#1 GOOD GUYS GARAGE DOORS INC", licenseNumber: "21360" });
    expect(entries.every((entry) => entry.name.length > 0)).toBe(true);
  });

  it("drops a name that maps to two licences rather than guessing one", () => {
    const index = buildContractorLicenseIndex([
      { name: "116 CONSTRUCTION LLC", licenseNumber: "CGC057328" },
      { name: "116 CONSTRUCTION, LLC", licenseNumber: "CGC1539101" },
      { name: "AYALA ELECTRIC, INC", licenseNumber: "EC13002630" },
    ]);
    expect(index.has(contractorMatchKey("116 CONSTRUCTION LLC"))).toBe(false);
    expect(index.get(contractorMatchKey("AYALA ELECTRIC INC"))).toBe("EC13002630");
  });

  it("pulls a licence printed inside the contractor name", () => {
    expect(licenseFromName("1CONTRACTOR PROJECTS-CCC1335680")).toBe("CCC1335680");
    expect(licenseFromName("BOWLES CUSTOM POOLS & SPAS INC")).toBeNull();
  });

  it("never promotes an owner or applicant to contractor of record", () => {
    expect(selectContractorOfRecord([{ role: "OWNER", name: "SMITH JOHN" }])).toBeNull();
    expect(selectContractorOfRecord([{ role: "APPLICANT", name: "SMITH JOHN" }])).toBeNull();
    expect(selectContractorOfRecord([{ role: "PRIVATE PROVIDER", name: "SOME INSPECTIONS LLC" }])).toBeNull();
    expect(
      selectContractorOfRecord([
        { role: "EL SUB", name: "AYALA ELECTRIC, INC" },
        { role: "CONTRACTOR", name: "BOWLES CUSTOM POOLS & SPAS INC" },
      ])?.name,
    ).toBe("BOWLES CUSTOM POOLS & SPAS INC");
  });
});

describe("normalization", () => {
  const licenseIndex = buildContractorLicenseIndex([
    { name: "BOWLES CUSTOM POOLS & SPAS INC", licenseNumber: "CPC1458033" },
  ]);

  it("binds the permit to the requested parcel and keeps every contact in the payload", () => {
    const detail = parsePermitDetailHtml(DETAIL_POOL, { expectedPermitNumber: "26-3627" });
    const record = normalizeClermontPermit({
      detail,
      row: parsePermitSearchResults(PARCEL).rows.at(-1),
      requestedAlternateKey: "3925114",
      requestedParcelId: "01-22-24-3900-027-00001",
      licenseIndex,
    });
    expect(record.countyKey).toBe("lake");
    expect(record.jurisdictionKey).toBe("clermont");
    expect(record.parcel_identifier).toBe("3925114");
    expect(record.requestedParcelIdentifier).toBe("3925114");
    expect(record.property_id).toBe(record.requestedPropertyId);
    expect(record.property_id).toMatch(/^[a-f0-9]{32}$/);
    expect(record.permit_number).toBe("26-3627");
    expect(record.improvement_type).toBe("RESIDENTIAL POOL");
    expect(record.improvement_status).toBe("ISSUED");
    expect(record.permit_issue_date).toBe("2026-09-01");
    expect(record.source_system).toBe("lake_clermont_etrakit_permits");
    expect(record.sourcePayload.contractorOfRecord).toBe("BOWLES CUSTOM POOLS & SPAS INC");
    expect(record.sourcePayload.contractorOfRecordLicense).toBe("CPC1458033");
    expect(record.contractors.map((contractor) => contractor.businessName)).toEqual([
      "BOWLES CUSTOM POOLS & SPAS INC",
      "AYALA ELECTRIC, INC",
    ]);
    expect(record.sourcePayload.contacts).toHaveLength(4);
    expect(record.isRoofPermit).toBe(false);
  });

  it("flags a roof permit and survives a permit with no parcel-id evidence", () => {
    const detail = parsePermitDetailHtml(DETAIL_ROOF, { expectedPermitNumber: "24-0009" });
    const record = normalizeClermontPermit({ detail, requestedAlternateKey: "3597940" });
    expect(record.isRoofPermit).toBe(true);
    expect(record.property_id).toBeNull();
    expect(record.requestedPropertyId).toBeNull();
    expect(record.sourcePayload.contractorOfRecord).toBe("WEST ORANGE ROOFING (CCC)");
    expect(record.final_inspection_date).toBe("2024-03-12");
  });

  it("refuses to attach a permit to a parcel the portal does not agree with", () => {
    const detail = parsePermitDetailHtml(DETAIL_POOL, { expectedPermitNumber: "26-3627" });
    expect(() => normalizeClermontPermit({ detail, requestedAlternateKey: "9999999" })).toThrow(
      /filed against parcel 3925114, not requested parcel 9999999/,
    );
  });
});

describe("prefix walk", () => {
  it("expands prefixes and year roots", () => {
    expect(expandPermitPrefix("26-1")).toEqual([
      "26-10", "26-11", "26-12", "26-13", "26-14", "26-15", "26-16", "26-17", "26-18", "26-19",
    ]);
    expect(permitYearPrefixes([25, "26"])).toEqual(["25-", "26-"]);
  });

  it("descends only into capped prefixes and prunes empty subtrees", async () => {
    /** @type {Record<string, { rows: object[], capped: boolean, noResults: boolean }>} */
    const portal = {
      "26-": { rows: [], capped: true, noResults: false },
      "26-0": { rows: [{ permitNumber: "26-0001" }, { permitNumber: "26-0002" }], capped: false, noResults: false },
      "26-1": { rows: [{ permitNumber: "26-1000" }], capped: true, noResults: false },
    };
    for (const digit of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      portal[`26-1${digit}`] = digit === 5
        ? { rows: [{ permitNumber: "26-1500" }], capped: false, noResults: false }
        : { rows: [], capped: false, noResults: true };
    }
    for (const digit of [2, 3, 4, 5, 6, 7, 8, 9]) {
      portal[`26-${digit}`] = { rows: [], capped: false, noResults: true };
    }
    const searched = [];
    const result = await walkPermitPrefixes({
      rootPrefixes: ["26-"],
      search: async (prefix) => {
        searched.push(prefix);
        const hit = portal[prefix];
        if (!hit) throw new Error(`unexpected prefix ${prefix}`);
        return hit;
      },
    });
    expect(result.rows.map((row) => row.permitNumber)).toEqual(["26-0001", "26-0002", "26-1500"]);
    expect(result.unresolvedPrefixes).toEqual([]);
    expect(result.terminalPrefixes).toContain("26-0");
    // 26-0 answered in one page, so its ten children were never requested.
    expect(searched).not.toContain("26-00");
    expect(searched.filter((prefix) => prefix.startsWith("26-1")).length).toBe(11);
    expect(result.prefixesSearched).toBe(searched.length);
  });

  it("reports a prefix still capped at max depth as unresolved rather than complete", async () => {
    const result = await walkPermitPrefixes({
      rootPrefixes: ["26-"],
      maxDepth: 1,
      search: async () => ({ rows: [{ permitNumber: "26-0001" }], capped: true, noResults: false }),
    });
    expect(result.unresolvedPrefixes).toHaveLength(10);
    expect(result.rows).toHaveLength(1);
  });
});

describe("session", () => {
  it("bootstraps once and then chains the viewstate between searches", async () => {
    /** @type {{ method: string, body: string | undefined }[]} */
    const calls = [];
    const session = createClermontPermitSession({
      fetchImpl: async (url, init) => {
        calls.push({ method: init?.method ?? "GET", body: init?.body });
        if ((init?.method ?? "GET") === "GET") return response(200, BOOTSTRAP);
        return response(200, `${BOOTSTRAP}${PARCEL}`);
      },
    });
    await session.searchByAlternateKey("3925114");
    await session.searchByPermitPrefix("26-12");
    expect(calls.map((call) => call.method)).toEqual(["GET", "POST", "POST"]);
    expect(session.stats().bootstraps).toBe(1);
    expect(String(calls[2].body)).toContain("txtSearchString=26-12");
    expect(String(calls[2].body)).toContain("ddSearchOper=BEGINS+WITH");
  });

  it("retries a transient 500 and returns the record on the retry", async () => {
    let attempt = 0;
    const session = createClermontPermitSession({
      sleep: async () => {},
      fetchImpl: async () => {
        attempt += 1;
        return attempt === 1 ? response(500, "Server Error") : response(200, DETAIL_POOL);
      },
    });
    const { detail } = await session.fetchPermitDetail("26-3627");
    expect(detail.permitNumber).toBe("26-3627");
    expect(session.stats().retries).toBe(1);
  });

  it("retries a silent partial render and does not report it as a permit with no contractor", async () => {
    let attempt = 0;
    const session = createClermontPermitSession({
      sleep: async () => {},
      fetchImpl: async () => {
        attempt += 1;
        return response(200, attempt === 1 ? DETAIL_PARTIAL : DETAIL_ROOF);
      },
    });
    const { detail } = await session.fetchPermitDetail("24-0009");
    expect(detail.contacts.length).toBeGreaterThan(0);
    expect(attempt).toBe(2);
  });

  it("gives up on a blocked response instead of hammering the portal", async () => {
    let calls = 0;
    const session = createClermontPermitSession({
      sleep: async () => {},
      fetchImpl: async () => {
        calls += 1;
        return response(403, "Access Denied");
      },
    });
    await expect(session.fetchPermitDetail("26-3627")).rejects.toMatchObject({
      classification: "blocked",
      code: "source_access_denied",
    });
    expect(calls).toBe(1);
  });

  it("stops after the attempt budget on a permanently sick endpoint", async () => {
    let calls = 0;
    const session = createClermontPermitSession({
      sleep: async () => {},
      maxAttempts: 3,
      fetchImpl: async () => {
        calls += 1;
        return response(502, "<html><body>Bad Gateway</body></html>");
      },
    });
    await expect(session.fetchPermitDetail("26-3627")).rejects.toMatchObject({ classification: "transient" });
    expect(calls).toBe(3);
  });
});
