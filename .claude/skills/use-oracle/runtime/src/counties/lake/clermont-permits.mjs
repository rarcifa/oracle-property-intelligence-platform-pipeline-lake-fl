/**
 * Clermont, FL permit adapter — CentralSquare eTRAKiT 3.
 *
 * Clermont is the largest municipality in Lake County and the **only** open
 * route to contractor of record anywhere in the county: the county's own CD
 * Plus permit layer (see {@link module:counties/lake/sources}) publishes no
 * contractor field, and every `lakecountyfl.gov` permit detail page sits
 * behind a Cloudflare managed challenge. Clermont's eTRAKiT portal answers
 * plain HTTP with no session, no login and no bot challenge, and its permit
 * detail pages render the full contact grid — CONTRACTOR, subs, applicant and
 * owner — server-side.
 *
 * Four measured portal constraints are encoded here rather than rediscovered
 * at run time (all measured 2026-09-09):
 *
 * - **The search grid caps at 100 rows**, served 20 to a page, and the pager is
 *   an ajax-only Telerik command that a plain form POST cannot drive: posting
 *   `Page$2` re-renders page 1. So a capped result set is never paged — it is
 *   split, exactly like the Accela date-window rule in `county-permit-adapter`.
 *   {@link planPermitPrefixWalk} does that split over permit numbers instead of
 *   dates, because Clermont numbers permits `YY-NNNN` and the search supports
 *   `PERMIT_NO BEGINS WITH`. A prefix whose response carries a pager is
 *   non-terminal and is descended into; a prefix without one is complete.
 * - **Search is an ASP.NET postback** carrying a ~316 KB `__VIEWSTATE`, so a
 *   session bootstraps once with a GET and then chains: every search response
 *   carries the form state for the next search.
 * - **Detail pages are a plain GET** — `permit.aspx?activityNo=<PERMIT_NO>` —
 *   with no session and no viewstate.
 * - **eTRAKiT renumbers its detail controls per record.** The same label is
 *   `cplMain_ctl07_lblPermitType` on one permit and `cplMain_ctl11_lblPermitType`
 *   on the next, so every selector here matches on the id *suffix*.
 *
 * The join needs no translation: the portal's "AK NUMBER" search field posts as
 * `SITE_APN` and holds the NAL `ALT_KEY` that the Lake seed and query table
 * already carry.
 *
 * **Silent partial renders.** Under concurrency the portal sometimes answers a
 * detail request with HTTP 200 and the full page chrome but no record at all.
 * Re-fetching the same URL returns the record. {@link parsePermitDetailHtml}
 * therefore fails closed on a body with no permit number and no permit type,
 * classified `transient` — recording such a page as "no contractor" would
 * silently under-report coverage, which is the failure this adapter exists to
 * avoid.
 *
 * @module counties/lake/clermont-permits
 */

import { createHash } from "node:crypto";

import * as cheerio from "cheerio";
import { z } from "zod";

import {
  createStablePermitId,
  normalizedPermitRecordSchema,
  PERMIT_RECORD_SCHEMA_VERSION,
} from "../../permits/contracts.mjs";
import { PermitSourceError, assertUsableResponse, classifyPermitError } from "../../permits/errors.mjs";
import { isRoofPermit, parsePortalDate } from "../../permits/normalization.mjs";
import { toText } from "./sources.mjs";

export const COUNTY_KEY = "lake";
export const JURISDICTION_KEY = "clermont";
export const CLERMONT_ETRAKIT_SEARCH_URL = "https://etrakit.clermontfl.org/eTRAKiT3/Search/permit.aspx";

/** Search grid page size, read off the RadGrid client state. */
export const SEARCH_PAGE_SIZE = 20;

/** Hard result cap the portal applies to any search (5 pages of 20). */
export const SEARCH_RESULT_CAP = 100;

/** `ddSearchBy` option values. The visible labels differ: `SITE_APN` shows as "AK NUMBER". */
export const SEARCH_FIELDS = Object.freeze({
  address: "Permit_Main.SITE_ADDR",
  permitNumber: "Permit_Main.PERMIT_NO",
  description: "Permit_Main.DESCRIPTION",
  alternateKey: "Permit_Main.SITE_APN",
  streetName: "Permit_Main.SITE_STREETNAME",
  issued: "Permit_Main.ISSUED",
  permitType: "Permit_Main.PERMITTYPE",
});

/** `ddSearchOper` option values. The portal offers no BETWEEN, hence prefix splitting. */
export const SEARCH_OPERATORS = Object.freeze({
  beginsWith: "BEGINS WITH",
  contains: "CONTAINS",
  equals: "EQUALS",
  atLeast: "AT LEAST",
  atMost: "AT MOST",
});

/**
 * Contact-grid roles that identify a *firm doing the work*, in descending
 * order of authority. Measured across a 66-permit sample on 2026-09-09, the
 * full role vocabulary was OWNER, APPLICANT, CONTRACTOR, EL SUB, PRIVATE
 * PROVIDER, PL SUB, MC SUB, GAS SUB, ROOFER and LICENSE HOLDER.
 *
 * `OWNER` and `APPLICANT` are deliberately excluded: an applicant is often the
 * homeowner, and treating one as a contractor would fabricate contractor data.
 * `PRIVATE PROVIDER` is a third-party inspection agency, kept as a contact but
 * never promoted to contractor of record.
 *
 * @type {readonly string[]}
 */
export const CONTRACTOR_ROLE_PRIORITY = Object.freeze([
  "CONTRACTOR",
  "GENERAL CONTRACTOR",
  "LICENSE HOLDER",
  "ROOFER",
  "EL SUB",
  "PL SUB",
  "MC SUB",
  "GAS SUB",
]);

/** Roles kept in `contractors[]` but never eligible as contractor of record. */
export const NON_CONTRACTOR_ROLES = Object.freeze(["OWNER", "APPLICANT", "PRIVATE PROVIDER"]);

/**
 * Florida license prefixes that appear in eTRAKiT contractor names and in the
 * portal's registered-contractor directory (`CCC` roofing, `CGC`/`CBC`/`CRC`
 * building, `EC`/`AEC` electrical, `CFC`/`CMC`/`CAC` mechanical, `CVC` solar).
 */
const LICENSE_PATTERN = /\b(?:CCC|CGC|CBC|CRC|CFC|CMC|CAC|CVC|AEC|EC|CPC|CUC)\s?\d{4,10}\b/i;

/**
 * @param {unknown} value - Raw cell text.
 * @returns {string | null} Collapsed text, or null when empty or an `&nbsp;` placeholder.
 */
export function cleanCell(value) {
  const text = toText(String(value ?? "").replace(/ /g, " ")).replace(/\s+/g, " ");
  return text === "" ? null : text;
}

/**
 * Read every ASP.NET hidden form field out of a rendered page.
 *
 * @param {string} html - Full page HTML.
 * @returns {Record<string, string>} Hidden field name → value, including `__VIEWSTATE`.
 */
export function parseAspNetFormState(html) {
  const $ = cheerio.load(html);
  /** @type {Record<string, string>} */
  const state = {};
  $("input[type=hidden][name]").each((_, element) => {
    const name = $(element).attr("name");
    if (name) state[name] = $(element).attr("value") ?? "";
  });
  if (!("__VIEWSTATE" in state)) {
    throw new PermitSourceError("eTRAKiT page carried no __VIEWSTATE", {
      classification: "transient",
      code: "etrakit_form_state_missing",
    });
  }
  return state;
}

/**
 * Build the search postback body. The contractor-login `<select>` is dropped:
 * it carries ~5,800 options and posting one would attempt a contractor login.
 *
 * @param {Record<string, string>} formState - Hidden fields from {@link parseAspNetFormState}.
 * @param {object} query - Search query.
 * @param {string} query.searchBy - A {@link SEARCH_FIELDS} value.
 * @param {string} query.operator - A {@link SEARCH_OPERATORS} value.
 * @param {string} query.value - Search term.
 * @returns {URLSearchParams} Form-encoded postback body.
 */
export function buildPermitSearchBody(formState, { searchBy, operator, value }) {
  const body = new URLSearchParams();
  for (const [name, fieldValue] of Object.entries(formState)) {
    if (name.startsWith("ctl00$ucLogin$ddlSelContractor")) continue;
    body.set(name, fieldValue);
  }
  body.set("__EVENTTARGET", "ctl00$cplMain$btnSearch");
  body.set("__EVENTARGUMENT", "");
  body.set("ctl00$ucLogin$ddlSelLogin", "Public");
  body.set("ctl00$ucLogin$RadTextBox2", "");
  body.set("ctl00$ucLogin$txtPassword", "");
  body.set("ctl00$cplMain$ddSearchBy", searchBy);
  body.set("ctl00$cplMain$ddSearchOper", operator);
  body.set("ctl00$cplMain$txtSearchString", value);
  return body;
}

export const permitSearchRowSchema = z
  .object({
    permitNumber: z.string().trim().min(1),
    issuedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    permitType: z.string().trim().min(1).nullable(),
    alternateKey: z.string().trim().min(1).nullable(),
    siteAddress: z.string().trim().min(1).nullable(),
    siteStreetName: z.string().trim().min(1).nullable(),
    description: z.string().trim().min(1).nullable(),
    recordId: z.string().trim().min(1).nullable(),
  })
  .strict();

export const permitSearchResultSchema = z
  .object({
    rows: z.array(permitSearchRowSchema),
    pageCount: z.number().int().positive(),
    /** True when the portal reported more than one page, i.e. the query must be split. */
    capped: z.boolean(),
    noResults: z.boolean(),
  })
  .strict();

/**
 * Parse a search-results page.
 *
 * The grid's last column (`RECORDID`) is rendered but hidden; it is kept
 * because it is the portal's own primary key and the only stable id for a
 * permit whose number is later reissued.
 *
 * @param {string} html - Search response HTML.
 * @returns {{ rows: object[], pageCount: number, capped: boolean, noResults: boolean }} Parsed grid.
 */
export function parsePermitSearchResults(html) {
  const $ = cheerio.load(html);
  const grid = $('table[id$="_rgSearchRslts_ctl00"]').first();
  const rows = grid
    .find("tbody > tr")
    .toArray()
    .map((element) => {
      const cells = $(element)
        .find("> td")
        .toArray()
        .map((cell) => cleanCell($(cell).text()));
      return cells;
    })
    .filter((cells) => cells.length >= 7 && cells[0] !== null)
    .map((cells) => ({
      permitNumber: /** @type {string} */ (cells[0]),
      issuedDate: parsePortalDate(cells[1]),
      permitType: cells[2],
      alternateKey: cells[3],
      siteAddress: cells[4],
      siteStreetName: cells[5],
      description: cells[6],
      recordId: cells[7] ?? null,
    }));

  const pagerText = grid.find("tfoot").text();
  const pageMatch = /page\s+\d+\s+of\s+(\d+)/i.exec(pagerText);
  const pageCount = pageMatch ? Number(pageMatch[1]) : 1;
  const noResults = rows.length === 0 && /there were no results/i.test($.root().text());

  if (rows.length === 0 && !noResults) {
    throw new PermitSourceError("eTRAKiT search response had neither results nor a no-results notice", {
      classification: "transient",
      code: "etrakit_search_shape_unrecognised",
    });
  }

  return permitSearchResultSchema.parse({
    rows,
    pageCount,
    capped: pageCount > 1,
    noResults,
  });
}

/**
 * Absolute detail URL for one permit. Plain GET, no session required.
 *
 * @param {string} permitNumber - Portal permit number, e.g. `26-3627`.
 * @returns {string} Detail URL.
 */
export function permitDetailUrl(permitNumber) {
  const number = toText(permitNumber);
  if (number === "") throw new PermitSourceError("permitNumber is required", {
    classification: "permanent",
    code: "missing_permit_number",
  });
  return `${CLERMONT_ETRAKIT_SEARCH_URL}?activityNo=${encodeURIComponent(number)}`;
}

export const permitContactSchema = z
  .object({
    role: z.string().trim().min(1),
    name: z.string().trim().min(1),
    phone: z.string().trim().min(1).nullable(),
    email: z.string().trim().min(1).nullable(),
    address: z.string().trim().min(1).nullable(),
    cityStateZip: z.string().trim().min(1).nullable(),
  })
  .strict();

export const permitInspectionSchema = z
  .object({
    inspectionType: z.string().trim().min(1),
    sequence: z.string().trim().min(1).nullable(),
    result: z.string().trim().min(1).nullable(),
    requestedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    inspectionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  })
  .strict();

export const permitDetailSchema = z
  .object({
    permitNumber: z.string().trim().min(1),
    permitType: z.string().trim().min(1).nullable(),
    permitSubtype: z.string().trim().min(1).nullable(),
    status: z.string().trim().min(1).nullable(),
    description: z.string().trim().min(1).nullable(),
    notes: z.string().trim().min(1).nullable(),
    appliedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    approvedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    issuedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    finaledDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    expirationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    alternateKey: z.string().trim().min(1).nullable(),
    siteAddress: z.string().trim().min(1).nullable(),
    siteCityStateZip: z.string().trim().min(1).nullable(),
    subdivision: z.string().trim().min(1).nullable(),
    lot: z.string().trim().min(1).nullable(),
    acres: z.string().trim().min(1).nullable(),
    propertyType: z.string().trim().min(1).nullable(),
    contacts: z.array(permitContactSchema),
    inspections: z.array(permitInspectionSchema),
  })
  .strict();

/**
 * @param {cheerio.CheerioAPI} $ - Loaded document.
 * @param {string} suffix - Control id suffix, e.g. `_lblPermitType`.
 * @returns {string | null} Label text, or null.
 */
function labelText($, suffix) {
  return cleanCell($(`[id$="${suffix}"]`).not('[id$="Lbl"]').not('[id$="Label"]').first().text());
}

/**
 * Parse a permit detail page.
 *
 * @param {string} html - Detail page HTML.
 * @param {object} [options] - Options.
 * @param {string} [options.expectedPermitNumber] - Permit number that was requested.
 * @returns {object} A {@link permitDetailSchema} record.
 * @throws {PermitSourceError} `transient` when the portal returned a chrome-only
 *   partial render, `permanent` when the page describes a different permit.
 */
export function parsePermitDetailHtml(html, options = {}) {
  const $ = cheerio.load(html);
  const permitNumber = cleanCell($('[id$="_lblPermitNo"]').first().text()) ?? cleanCell(options.expectedPermitNumber);
  const permitType = labelText($, "_lblPermitType");

  if (permitNumber === null || permitType === null) {
    throw new PermitSourceError(
      `eTRAKiT returned a detail page with no permit record for "${toText(options.expectedPermitNumber)}"`,
      { classification: "transient", code: "etrakit_detail_partial_render" },
    );
  }
  if (options.expectedPermitNumber && permitNumber !== toText(options.expectedPermitNumber)) {
    throw new PermitSourceError(
      `eTRAKiT served permit ${permitNumber} for requested permit ${toText(options.expectedPermitNumber)}`,
      { classification: "permanent", code: "etrakit_detail_permit_mismatch" },
    );
  }

  const contacts = $('table[id*="rgContactInfo"][id$="_ctl00"]')
    .first()
    .find("tbody > tr")
    .toArray()
    .map((element) => $(element).find("> td").toArray().map((cell) => cleanCell($(cell).text())))
    .filter((cells) => cells.length >= 2 && cells[0] !== null && cells[1] !== null)
    .map((cells) => ({
      role: /** @type {string} */ (cells[0]).toUpperCase(),
      name: /** @type {string} */ (cells[1]),
      phone: cells[2] ?? null,
      email: cells[3] ?? null,
      address: cells[4] ?? null,
      cityStateZip: cells[5] ?? null,
    }));

  const inspections = $('table[id*="rgInspectionInfo"][id$="_ctl00"]')
    .first()
    .find("tbody > tr")
    .toArray()
    .map((element) => $(element).find("> td").toArray().map((cell) => cleanCell($(cell).text())))
    .filter((cells) => cells.length >= 2 && cells[0] !== null)
    .map((cells) => ({
      inspectionType: /** @type {string} */ (cells[0]),
      sequence: cells[1] ?? null,
      result: cells[2] ?? null,
      requestedDate: parsePortalDate(cells[3]),
      inspectionDate: parsePortalDate(cells[5]),
    }));

  return permitDetailSchema.parse({
    permitNumber,
    permitType,
    permitSubtype: labelText($, "_lblPermitSubtype"),
    status: labelText($, "_lblPermitStatus"),
    description: labelText($, "_lblPermitDesc"),
    notes: labelText($, "_lblPermitNotes"),
    appliedDate: parsePortalDate(labelText($, "_lblPermitAppliedDate")),
    approvedDate: parsePortalDate(labelText($, "_lblPermitApprovedDate")),
    issuedDate: parsePortalDate(labelText($, "_lblPermitIssuedDate")),
    finaledDate: parsePortalDate(labelText($, "_lblPermitFinaledDate")),
    expirationDate: parsePortalDate(labelText($, "_lblPermitExpirationDate")),
    alternateKey: cleanCell($('a[title="Go to Parcel"]').first().text()),
    siteAddress: cleanCell($('[id$="_hlSiteAddress"]').first().text()),
    siteCityStateZip: labelText($, "_lblSiteCityStateZip"),
    subdivision: labelText($, "_lblSiteSubdivision"),
    lot: labelText($, "_lblSiteLotNo"),
    acres: labelText($, "_lblSiteLotSqFt"),
    propertyType: labelText($, "_lblPropertyType"),
    contacts,
    inspections,
  });
}

/**
 * Parse the registered-contractor directory that eTRAKiT renders inline in its
 * contractor-login `<select>` (5,863 entries on 2026-09-09). It is the only
 * open source of Florida licence numbers reachable for Lake County — DBPR
 * answers 403 to every egress tested — so it is used to attach a licence to a
 * contractor name that the contact grid gives without one.
 *
 * @param {string} html - Any eTRAKiT page carrying the login control.
 * @returns {{ name: string, licenseNumber: string }[]} Directory entries with a name.
 */
export function parseContractorLicenseDirectory(html) {
  const $ = cheerio.load(html);
  return $('select[name$="ddlSelContractor"] option')
    .toArray()
    .map((element) => ({
      name: cleanCell($(element).text()),
      licenseNumber: cleanCell($(element).attr("value")),
    }))
    .filter(
      /** @returns {entry is { name: string, licenseNumber: string }} */
      (entry) => entry.name !== null && entry.licenseNumber !== null,
    );
}

/**
 * Normalize a contractor name for directory matching: upper-cased, licence
 * suffixes and punctuation stripped, corporate suffixes kept (two firms can
 * differ only by `LLC` vs `INC`).
 *
 * @param {string} name - Contractor name as printed on the portal.
 * @returns {string} Match key.
 */
export function contractorMatchKey(name) {
  return toText(name)
    .toUpperCase()
    .replace(LICENSE_PATTERN, " ")
    .replace(/\((?:CCC|CGC|CBC|CRC|CFC|CMC|CAC|CVC|AEC|EC)\)/gi, " ")
    .replace(/[.,'"]/g, " ")
    .replace(/[^A-Z0-9&\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Index a contractor directory by match key. Names that map to more than one
 * licence are dropped rather than guessed — a wrong licence number is worse
 * than a null one.
 *
 * @param {readonly { name: string, licenseNumber: string }[]} entries - Directory entries.
 * @returns {Map<string, string>} Match key → licence number.
 */
export function buildContractorLicenseIndex(entries) {
  /** @type {Map<string, string | null>} */
  const index = new Map();
  for (const entry of entries) {
    const key = contractorMatchKey(entry.name);
    if (key === "") continue;
    const existing = index.get(key);
    if (existing === undefined) index.set(key, entry.licenseNumber);
    else if (existing !== entry.licenseNumber) index.set(key, null);
  }
  return new Map(
    [...index.entries()].filter(
      /** @returns {entry is [string, string]} */ (entry) => entry[1] !== null,
    ),
  );
}

/**
 * Pick the contractor of record from a permit's contact grid.
 *
 * @param {readonly { role: string, name: string }[]} contacts - Parsed contacts.
 * @returns {{ role: string, name: string } | null} Highest-authority contractor, or null.
 */
export function selectContractorOfRecord(contacts) {
  for (const role of CONTRACTOR_ROLE_PRIORITY) {
    const match = contacts.find((contact) => contact.role.toUpperCase() === role);
    if (match) return match;
  }
  return null;
}

/**
 * Extract a licence number printed inside a contractor name, e.g.
 * `1CONTRACTOR PROJECTS-CCC1335680`.
 *
 * @param {string} name - Contractor name.
 * @returns {string | null} Licence number, or null.
 */
export function licenseFromName(name) {
  const match = LICENSE_PATTERN.exec(toText(name));
  return match ? match[0].toUpperCase().replace(/\s+/g, "") : null;
}

/**
 * Deterministic Lake property id, matching `counties/lake/query-table`.
 *
 * @param {string} parcelId - NAL `PARCEL_ID`.
 * @returns {string} 32-hex property id.
 */
export function lakePropertyId(parcelId) {
  return createHash("sha256").update(`${COUNTY_KEY}:${parcelId}`).digest("hex").slice(0, 32);
}

/**
 * Normalize one Clermont permit into the runtime's shared
 * `normalizedPermitRecordSchema` shape.
 *
 * The permit is bound to the parcel the *caller* asked for, never to whatever
 * parcel the detail page happens to display; a detail page whose `Parcel#`
 * contradicts the request is rejected rather than silently re-pointed.
 *
 * @param {object} input - Normalization input.
 * @param {object} input.detail - A {@link permitDetailSchema} record.
 * @param {object} [input.row] - The matching {@link permitSearchRowSchema} row, when the permit came from a list.
 * @param {string} input.requestedAlternateKey - NAL `ALT_KEY` the permit is being attached to.
 * @param {string | null} [input.requestedParcelId] - NAL `PARCEL_ID`, when known, used for `property_id`.
 * @param {Map<string, string>} [input.licenseIndex] - Index from {@link buildContractorLicenseIndex}.
 * @returns {object} A validated `normalizedPermitRecordSchema` record.
 */
export function normalizeClermontPermit({
  detail,
  row = undefined,
  requestedAlternateKey,
  requestedParcelId = null,
  licenseIndex = new Map(),
}) {
  const alternateKey = toText(requestedAlternateKey);
  if (alternateKey === "") {
    throw new PermitSourceError("requestedAlternateKey is required", {
      classification: "permanent",
      code: "missing_requested_parcel",
    });
  }
  if (detail.alternateKey !== null && detail.alternateKey !== alternateKey) {
    throw new PermitSourceError(
      `Permit ${detail.permitNumber} is filed against parcel ${detail.alternateKey}, not requested parcel ${alternateKey}`,
      { classification: "permanent", code: "etrakit_detail_parcel_mismatch" },
    );
  }

  const propertyId = requestedParcelId === null ? null : lakePropertyId(requestedParcelId);
  const ofRecord = selectContractorOfRecord(detail.contacts);
  const contractors = detail.contacts
    .filter((contact) => !NON_CONTRACTOR_ROLES.includes(contact.role.toUpperCase()))
    .map((contact) => ({
      businessName: contact.name,
      licenseNumber:
        licenseFromName(contact.name) ?? licenseIndex.get(contractorMatchKey(contact.name)) ?? null,
      qualifierName: null,
      phone: contact.phone,
      email: contact.email,
    }));

  const sourceRecordId = toText(row?.recordId ?? "") || detail.permitNumber;

  return normalizedPermitRecordSchema.parse({
    schemaVersion: PERMIT_RECORD_SCHEMA_VERSION,
    countyKey: COUNTY_KEY,
    jurisdictionKey: JURISDICTION_KEY,
    property_improvement_id: createStablePermitId({
      countyKey: COUNTY_KEY,
      jurisdictionKey: JURISDICTION_KEY,
      sourceRecordId,
    }),
    property_id: propertyId,
    parcel_identifier: alternateKey,
    permit_number: detail.permitNumber,
    improvement_type: detail.permitType,
    improvement_status: detail.status,
    improvement_action: detail.permitSubtype,
    permit_issue_date: detail.issuedDate,
    application_received_date: detail.appliedDate,
    final_inspection_date: detail.finaledDate,
    permit_close_date: detail.finaledDate,
    completion_date: detail.finaledDate,
    expiration_date: detail.expirationDate,
    opened_date: detail.appliedDate,
    source_system: "clermont-etrakit3",
    county_name: "Lake",
    project_description: detail.description,
    description: row?.description ?? detail.description,
    estimated_job_value: null,
    fee: null,
    sourceRecordId,
    sourceUrl: permitDetailUrl(detail.permitNumber),
    requestedParcelIdentifier: alternateKey,
    requestedPropertyId: propertyId,
    workAddress: detail.siteAddress,
    isRoofPermit: isRoofPermit(detail.permitType, detail.permitSubtype, detail.description, row?.description),
    contractors,
    inspections: detail.inspections.map((inspection) => ({
      inspectionType: inspection.inspectionType,
      inspectionDate: inspection.inspectionDate,
      result: inspection.result,
    })),
    relatedRecords: [],
    sourcePayload: {
      contractorOfRecord: ofRecord?.name ?? null,
      contractorOfRecordRole: ofRecord?.role ?? null,
      contractorOfRecordLicense:
        ofRecord === null
          ? null
          : (licenseFromName(ofRecord.name) ?? licenseIndex.get(contractorMatchKey(ofRecord.name)) ?? null),
      approvedDate: detail.approvedDate,
      notes: detail.notes,
      subdivision: detail.subdivision,
      lot: detail.lot,
      acres: detail.acres,
      propertyType: detail.propertyType,
      siteCityStateZip: detail.siteCityStateZip,
      contacts: detail.contacts,
      searchRow: row ?? null,
    },
  });
}

/**
 * Expand one permit-number prefix into its ten children.
 *
 * @param {string} prefix - Prefix such as `26-1`.
 * @returns {string[]} `26-10` … `26-19`.
 */
export function expandPermitPrefix(prefix) {
  return Array.from({ length: 10 }, (_, digit) => `${prefix}${digit}`);
}

/**
 * Root prefixes for a set of permit-number years.
 *
 * @param {readonly (string | number)[]} years - Two-digit years, e.g. `["25", "26"]`.
 * @returns {string[]} Root prefixes such as `25-`.
 */
export function permitYearPrefixes(years) {
  return years.map((year) => {
    const text = String(year).padStart(2, "0").slice(-2);
    if (!/^\d{2}$/.test(text)) throw new Error(`Invalid permit year "${year}"`);
    return `${text}-`;
  });
}

/**
 * Walk the permit-number prefix tree, splitting any prefix the portal reports
 * as multi-page and stopping at any prefix it answers in a single page. This
 * is the Clermont analogue of the Accela date-window binary split: the portal
 * caps at {@link SEARCH_RESULT_CAP} rows and will not serve page 2 to a form
 * POST, so a prefix is only ever *complete* when it fits on one page.
 *
 * A prefix with zero results prunes its whole subtree, which is what keeps the
 * walk cheap: Clermont issues roughly 3,700 permits a year, so most of the
 * `YY-NNNN` space is empty.
 *
 * @param {object} options - Walk options.
 * @param {readonly string[]} options.rootPrefixes - Starting prefixes, from {@link permitYearPrefixes}.
 * @param {(prefix: string) => Promise<{ rows: object[], capped: boolean, noResults: boolean }>} options.search - Search executor.
 * @param {number} [options.maxDepth] - Maximum digits appended to a root prefix. `YY-NNNN` needs 4.
 * @param {(event: { prefix: string, rows: number, capped: boolean }) => void} [options.onPrefix] - Progress hook.
 * @returns {Promise<{ rows: object[], prefixesSearched: number, terminalPrefixes: string[], unresolvedPrefixes: string[] }>}
 *   Deduplicated rows plus the walk's shape. `unresolvedPrefixes` is non-empty
 *   only if the portal still reported a pager at `maxDepth`, which would mean
 *   the numbering assumption changed — the caller must treat that as a gap.
 */
export async function walkPermitPrefixes({ rootPrefixes, search, maxDepth = 4, onPrefix = () => {} }) {
  /** @type {Map<string, object>} */
  const rows = new Map();
  /** @type {string[]} */
  const terminalPrefixes = [];
  /** @type {string[]} */
  const unresolvedPrefixes = [];
  let prefixesSearched = 0;

  /**
   * @param {string} prefix - Prefix to search.
   * @param {number} depth - Digits appended so far.
   * @returns {Promise<void>} Nothing.
   */
  async function visit(prefix, depth) {
    const result = await search(prefix);
    prefixesSearched += 1;
    onPrefix({ prefix, rows: result.rows.length, capped: result.capped });
    if (result.noResults) return;
    if (!result.capped) {
      for (const row of result.rows) rows.set(row.permitNumber, row);
      terminalPrefixes.push(prefix);
      return;
    }
    if (depth >= maxDepth) {
      unresolvedPrefixes.push(prefix);
      for (const row of result.rows) rows.set(row.permitNumber, row);
      return;
    }
    for (const child of expandPermitPrefix(prefix)) await visit(child, depth + 1);
  }

  for (const root of rootPrefixes) await visit(root, 0);

  return {
    rows: [...rows.values()].sort((left, right) => left.permitNumber.localeCompare(right.permitNumber)),
    prefixesSearched,
    terminalPrefixes,
    unresolvedPrefixes,
  };
}

/**
 * Create a Clermont eTRAKiT session.
 *
 * The session holds the ASP.NET form state and chains it: each search response
 * supplies the viewstate for the next search, so only the first search pays a
 * bootstrap GET. Detail requests do not touch the session at all.
 *
 * @param {object} [options] - Session options.
 * @param {typeof fetch} [options.fetchImpl] - Injected fetch, for tests.
 * @param {string} [options.baseUrl] - Search page URL.
 * @param {string} [options.userAgent] - User-Agent header.
 * @param {number} [options.timeoutMs] - Per-request timeout.
 * @param {number} [options.maxAttempts] - Attempts per request before a transient error is rethrown.
 * @param {(ms: number) => Promise<void>} [options.sleep] - Injected backoff sleep, for tests.
 * @returns {{
 *   search: (query: { searchBy: string, operator: string, value: string }) => Promise<object>,
 *   searchByAlternateKey: (alternateKey: string) => Promise<object>,
 *   searchByPermitPrefix: (prefix: string) => Promise<object>,
 *   fetchPermitDetail: (permitNumber: string) => Promise<{ detail: object, html: string }>,
 *   loadContractorLicenseIndex: () => Promise<Map<string, string>>,
 *   stats: () => { requests: number, retries: number, bootstraps: number }
 * }} Session handle.
 */
export function createClermontPermitSession(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? CLERMONT_ETRAKIT_SEARCH_URL;
  const userAgent =
    options.userAgent ??
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxAttempts = options.maxAttempts ?? 4;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  /** @type {Record<string, string> | null} */
  let formState = null;
  /** @type {string | null} */
  let bootstrapHtml = null;
  const stats = { requests: 0, retries: 0, bootstraps: 0 };

  /**
   * Issue one portal request, retrying transient failures.
   *
   * `parse` runs **inside** the retry loop on purpose. The portal's worst
   * failure mode is not an HTTP error but a silent partial render — HTTP 200,
   * full chrome, no record — so the body has to be validated before an attempt
   * counts as a success, or the harvester would record a real permit as having
   * no contractor.
   *
   * @template T
   * @param {string} url - Absolute URL.
   * @param {URLSearchParams | null} body - POST body, or null for a GET.
   * @param {(text: string) => T} [parse] - Body validator/parser run inside the retry loop.
   * @returns {Promise<{ text: string, parsed: T }>} Response body and parse result.
   */
  async function request(url, body, parse = /** @type {(text: string) => T} */ ((text) => text)) {
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (attempt > 1) {
        stats.retries += 1;
        await sleep(Math.min(1000 * 2 ** (attempt - 2), 8000));
      }
      try {
        stats.requests += 1;
        const response = await fetchImpl(url, {
          method: body === null ? "GET" : "POST",
          headers: {
            "User-Agent": userAgent,
            Accept: "text/html,application/xhtml+xml",
            ...(body === null ? {} : { "Content-Type": "application/x-www-form-urlencoded", Referer: baseUrl }),
          },
          ...(body === null ? {} : { body: body.toString() }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await response.text();
        assertUsableResponse(response, text);
        return { text, parsed: parse(text) };
      } catch (error) {
        const classified = classifyPermitError(error);
        if (classified.classification !== "transient") throw classified;
        lastError = classified;
        formState = null;
      }
    }
    throw lastError;
  }

  /**
   * @returns {Promise<Record<string, string>>} Current form state, bootstrapping if needed.
   */
  async function ensureFormState() {
    if (formState !== null) return formState;
    stats.bootstraps += 1;
    const bootstrap = await request(baseUrl, null, parseAspNetFormState);
    bootstrapHtml = bootstrap.text;
    formState = bootstrap.parsed;
    return formState;
  }

  /**
   * @param {{ searchBy: string, operator: string, value: string }} query - Search query.
   * @returns {Promise<object>} Parsed search result.
   */
  async function search(query) {
    const state = await ensureFormState();
    const { text, parsed } = await request(
      baseUrl,
      buildPermitSearchBody(state, query),
      parsePermitSearchResults,
    );
    try {
      formState = parseAspNetFormState(text);
    } catch {
      formState = null;
    }
    return parsed;
  }

  return {
    search,
    searchByAlternateKey: (alternateKey) =>
      search({
        searchBy: SEARCH_FIELDS.alternateKey,
        operator: SEARCH_OPERATORS.equals,
        value: toText(alternateKey),
      }),
    searchByPermitPrefix: (prefix) =>
      search({
        searchBy: SEARCH_FIELDS.permitNumber,
        operator: SEARCH_OPERATORS.beginsWith,
        value: toText(prefix),
      }),
    async fetchPermitDetail(permitNumber) {
      const { text, parsed } = await request(permitDetailUrl(permitNumber), null, (html) =>
        parsePermitDetailHtml(html, { expectedPermitNumber: permitNumber }),
      );
      return { detail: parsed, html: text };
    },
    async loadContractorLicenseIndex() {
      if (bootstrapHtml === null) await ensureFormState();
      return buildContractorLicenseIndex(parseContractorLicenseDirectory(/** @type {string} */ (bootstrapHtml)));
    },
    stats: () => ({ ...stats }),
  };
}
