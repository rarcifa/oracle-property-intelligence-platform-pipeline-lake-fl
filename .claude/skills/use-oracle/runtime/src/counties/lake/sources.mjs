/**
 * Lake County, FL bulk source adapters: Florida DOR tax-roll files, the
 * Florida Geographic Information Office (GIO) statewide parcel-centroid
 * FeatureServer, and the Lake County CD Plus permit layer.
 *
 * Lake is a **bulk-first** county. Its property appraiser portal
 * (`lakecopropappr.com`) and its per-permit detail pages
 * (`c.lakecountyfl.gov/.../permit_report.ashx`) both answer HTTP 403 to every
 * egress tested, so — unlike Duval and Pinellas, whose adapters capture one
 * HTML page per parcel — Lake's record of origin is the published bulk roll.
 * Every function here therefore fetches a *dataset*, not a parcel page.
 *
 * Two measured source constraints are encoded as constants rather than
 * rediscovered at run time:
 *
 * - The GIO FeatureServer stops honouring `resultOffset` past roughly 20,000
 *   rows, so paging is done with `returnIdsOnly` followed by OBJECTID range
 *   queries ({@link OBJECT_ID_PAGE_SIZE} per page).
 * - The CD Plus layer answers HTTP 500 to `IN (...)` lists longer than about
 *   50 values, so permit windows are also expressed as OBJECTID ranges.
 *
 * @module counties/lake/sources
 */

import { z } from "zod";

export const DOR_PORTAL_BASE = "https://floridarevenue.com/property/dataportal";
export const DOR_TAX_ROLL_ROOT = "/property/dataportal/Documents/PTO Data Portal/Tax Roll Data Files";
export const DOR_COUNTY_CODE = "45";
export const DOR_ROLL_YEAR = "2026P";

export const GIO_CENTROID_LAYER =
  "https://services9.arcgis.com/Gh9awoU677aKree0/arcgis/rest/services/Florida_Statewide_Parcel_Centroid_Version/FeatureServer/0";

export const CDPLUS_PERMIT_LAYER =
  "https://utility.arcgis.com/usrsvcs/servers/365d9a169bc34110a3db2157c76f6c95/rest/services/Individual/CDPermitParcels/MapServer/0";

/** OBJECTID-range page size. The GIO service degrades above ~2,000 rows per request. */
export const OBJECT_ID_PAGE_SIZE = 2000;

/**
 * CD Plus `Permit_Type` codes that denote roofing work, measured from the
 * live layer's distinct-value set on 2026-09-09 (RF 18, RFC 98, RFR 3099,
 * ROC 7, ROR 90 = 3,312 features). `RFR` is residential re-roof and carries
 * the overwhelming majority.
 *
 * @type {readonly string[]}
 */
export const ROOFING_PERMIT_TYPES = Object.freeze(["RF", "RFC", "RFR", "ROC", "ROR"]);

/**
 * CD Plus `Permit_Status` values that mean the permit is still open. The
 * layer's full status vocabulary is APPLY, CANCEL, COED, EXPIRED, FINAL,
 * INSPECT, ISSUED, READY, RENEWED, REVOKE, VOID, closed_ni.
 *
 * @type {readonly string[]}
 */
export const OPEN_PERMIT_STATUSES = Object.freeze(["APPLY", "INSPECT", "ISSUED", "READY", "RENEWED"]);

/**
 * @param {unknown} value - Raw scalar.
 * @returns {string} Trimmed text, or the empty string.
 */
export function toText(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

/**
 * Build the DOR Data Portal SharePoint REST URL that lists one tax-roll folder.
 *
 * @param {string} dataset - Dataset folder name (`NAL`, `SDF`, or `NAP`).
 * @param {string} [year] - Roll-year folder. Defaults to {@link DOR_ROLL_YEAR}.
 * @returns {string} Absolute `_api/web/GetFolderByServerRelativeUrl(...)/Files` URL.
 */
export function dorFolderListingUrl(dataset, year = DOR_ROLL_YEAR) {
  const folder = `${DOR_TAX_ROLL_ROOT}/${dataset}/${year}`;
  return `${DOR_PORTAL_BASE}/_api/web/GetFolderByServerRelativeUrl('${encodeURIComponent(folder)}')/Files`;
}

const dorFileSchema = z
  .object({
    Name: z.string().min(1),
    ServerRelativeUrl: z.string().min(1),
    Length: z.union([z.string(), z.number()]).optional(),
    TimeLastModified: z.string().optional(),
  })
  .loose();

/**
 * List the files published in one DOR tax-roll folder.
 *
 * @param {string} dataset - Dataset folder name (`NAL`, `SDF`, or `NAP`).
 * @param {object} [options] - Fetch options.
 * @param {typeof fetch} [options.fetchImpl] - Injected fetch, for tests.
 * @param {string} [options.year] - Roll-year folder.
 * @returns {Promise<{ name: string, serverRelativeUrl: string, bytes: number | null, lastModified: string | null }[]>}
 *   One entry per published file.
 */
export async function listDorFiles(dataset, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(dorFolderListingUrl(dataset, options.year), {
    headers: { Accept: "application/json;odata=nometadata" },
  });
  if (!response.ok) {
    throw new Error(`DOR folder listing HTTP ${response.status} for ${dataset}`);
  }
  const payload = await response.json();
  const values = Array.isArray(payload) ? payload : (payload?.value ?? []);
  return values.map((entry) => {
    const file = dorFileSchema.parse(entry);
    const bytes = file.Length === undefined ? null : Number(file.Length);
    return {
      name: file.Name,
      serverRelativeUrl: file.ServerRelativeUrl,
      bytes: Number.isFinite(bytes) ? bytes : null,
      lastModified: file.TimeLastModified ?? null,
    };
  });
}

/**
 * Find the Lake County file inside a DOR folder listing.
 *
 * @param {readonly { name: string, serverRelativeUrl: string }[]} files - Folder listing.
 * @param {string} dataset - Dataset name used in the file name (`NAL`, `SDF`, or `TPP`).
 * @returns {{ name: string, serverRelativeUrl: string }} The matching entry.
 */
export function selectLakeRollFile(files, dataset) {
  const wanted = files.filter(
    (file) => /^lake\b/i.test(file.name) && file.name.toUpperCase().includes(dataset.toUpperCase()),
  );
  if (wanted.length !== 1) {
    throw new Error(
      `Expected exactly one Lake ${dataset} file in the DOR listing, found ${wanted.length}: ${files
        .map((file) => file.name)
        .join(", ")}`,
    );
  }
  return wanted[0];
}

/**
 * Absolute download URL for a DOR server-relative path.
 *
 * @param {string} serverRelativeUrl - Path from the folder listing.
 * @returns {string} Absolute HTTPS URL with each path segment encoded.
 */
export function dorDownloadUrl(serverRelativeUrl) {
  const encoded = serverRelativeUrl
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `https://floridarevenue.com${encoded}`;
}

/**
 * Build an ArcGIS REST query URL.
 *
 * @param {string} layerUrl - Feature/Map service layer URL.
 * @param {Record<string, string>} params - Query parameters.
 * @returns {string} Absolute query URL.
 */
export function arcgisQueryUrl(layerUrl, params) {
  const search = new URLSearchParams({ f: "json", ...params });
  return `${layerUrl}/query?${search.toString()}`;
}

/**
 * Fetch and parse one ArcGIS query, failing closed on the service's
 * in-band `error` envelope (ArcGIS answers HTTP 200 with an error body).
 *
 * @param {string} url - Absolute query URL.
 * @param {typeof fetch} fetchImpl - Fetch implementation.
 * @returns {Promise<Record<string, unknown>>} Parsed response payload.
 */
async function arcgisFetch(url, fetchImpl) {
  const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`ArcGIS HTTP ${response.status} for ${url}`);
  }
  const payload = await response.json();
  if (payload && typeof payload === "object" && "error" in payload) {
    const detail = /** @type {{ error?: { message?: string, code?: number } }} */ (payload).error;
    throw new Error(`ArcGIS error ${detail?.code ?? "?"}: ${detail?.message ?? "unknown"} for ${url}`);
  }
  return payload;
}

/**
 * Fetch every OBJECTID matching a where clause. This is the first half of
 * the ids-only paging strategy that works around the GIO service's broken
 * `resultOffset` past ~20,000 rows.
 *
 * @param {string} layerUrl - Layer URL.
 * @param {string} where - SQL where clause.
 * @param {object} [options] - Options.
 * @param {typeof fetch} [options.fetchImpl] - Injected fetch.
 * @returns {Promise<number[]>} Ascending OBJECTIDs.
 */
export async function fetchObjectIds(layerUrl, where, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const payload = await arcgisFetch(arcgisQueryUrl(layerUrl, { where, returnIdsOnly: "true" }), fetchImpl);
  const ids = /** @type {{ objectIds?: unknown }} */ (payload).objectIds;
  if (!Array.isArray(ids)) {
    throw new Error(`ArcGIS returned no objectIds array for ${layerUrl}`);
  }
  return ids.map((id) => Number(id)).sort((left, right) => left - right);
}

/**
 * Split an ascending OBJECTID list into contiguous inclusive ranges of at
 * most `pageSize` ids each.
 *
 * @param {readonly number[]} objectIds - Ascending OBJECTIDs.
 * @param {number} [pageSize] - Ids per page. Defaults to {@link OBJECT_ID_PAGE_SIZE}.
 * @returns {{ min: number, max: number, count: number }[]} Inclusive ranges.
 */
export function toObjectIdRanges(objectIds, pageSize = OBJECT_ID_PAGE_SIZE) {
  if (pageSize < 1) throw new Error("pageSize must be at least 1");
  /** @type {{ min: number, max: number, count: number }[]} */
  const ranges = [];
  for (let index = 0; index < objectIds.length; index += pageSize) {
    const page = objectIds.slice(index, index + pageSize);
    ranges.push({ min: page[0], max: page[page.length - 1], count: page.length });
  }
  return ranges;
}

/**
 * Fetch one OBJECTID range of features.
 *
 * @param {string} layerUrl - Layer URL.
 * @param {{ min: number, max: number }} range - Inclusive OBJECTID range.
 * @param {object} options - Options.
 * @param {string} options.outFields - Comma-separated field list.
 * @param {string} [options.where] - Additional where clause, ANDed with the range.
 * @param {boolean} [options.returnGeometry] - Whether to request geometry.
 * @param {typeof fetch} [options.fetchImpl] - Injected fetch.
 * @returns {Promise<Record<string, unknown>[]>} Feature attribute records (geometry folded in as `geometry`).
 */
export async function fetchObjectIdRange(layerUrl, range, options) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const rangeClause = `OBJECTID >= ${range.min} AND OBJECTID <= ${range.max}`;
  const where = options.where ? `(${options.where}) AND ${rangeClause}` : rangeClause;
  const payload = await arcgisFetch(
    arcgisQueryUrl(layerUrl, {
      where,
      outFields: options.outFields,
      returnGeometry: options.returnGeometry === true ? "true" : "false",
      outSR: "4326",
    }),
    fetchImpl,
  );
  const features = /** @type {{ features?: unknown }} */ (payload).features;
  if (!Array.isArray(features)) return [];
  return features.map((feature) => {
    const record = /** @type {{ attributes?: Record<string, unknown>, geometry?: unknown }} */ (feature);
    return { ...(record.attributes ?? {}), geometry: record.geometry ?? null };
  });
}

/**
 * Run an async mapper over items with a bounded concurrency window, so a
 * full-county page walk never opens more sockets than the source tolerates.
 *
 * @template T, R
 * @param {readonly T[]} items - Work items.
 * @param {number} concurrency - Maximum in-flight operations.
 * @param {(item: T, index: number) => Promise<R>} mapper - Async mapper.
 * @returns {Promise<R[]>} Results in input order.
 */
export async function mapWithConcurrency(items, concurrency, mapper) {
  if (concurrency < 1) throw new Error("concurrency must be at least 1");
  /** @type {R[]} */
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * @param {Record<string, unknown>} permit - Raw CD Plus feature record.
 * @returns {boolean} Whether the permit is roofing work.
 */
export function isRoofingPermit(permit) {
  return ROOFING_PERMIT_TYPES.includes(toText(permit.Permit_Type).toUpperCase());
}

/**
 * @param {Record<string, unknown>} permit - Raw CD Plus feature record.
 * @returns {boolean} Whether the permit is still open.
 */
export function isOpenPermit(permit) {
  return OPEN_PERMIT_STATUSES.includes(toText(permit.Permit_Status).toUpperCase());
}

/**
 * Convert an Esri epoch-milliseconds field to an ISO date (UTC, date only).
 *
 * @param {unknown} value - Epoch milliseconds, or null.
 * @returns {string | null} `YYYY-MM-DD`, or null.
 */
export function esriEpochToIsoDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const epoch = Number(value);
  if (!Number.isFinite(epoch) || epoch <= 0) return null;
  return new Date(epoch).toISOString().slice(0, 10);
}

/**
 * Normalize one raw CD Plus feature into the permit shape the query table
 * and the permit artifacts both consume.
 *
 * @param {Record<string, unknown>} feature - Raw CD Plus attributes.
 * @returns {{
 *   permit_number: string, alternate_key: string, parcel_id: string,
 *   permit_type: string, permit_desc: string | null, permit_status: string,
 *   applied_date: string | null, approved_date: string | null,
 *   issued_date: string | null, co_date: string | null,
 *   last_modified: string | null, permit_url: string | null,
 *   is_roofing: boolean, is_open: boolean, days_open: number | null
 * }} Normalized permit.
 */
export function normalizePermit(feature) {
  const applied = esriEpochToIsoDate(feature.PermitApplied_Date);
  const issued = esriEpochToIsoDate(feature.PermitIssued_Date);
  const co = esriEpochToIsoDate(feature.CO_Date);
  const open = isOpenPermit(feature);
  const start = issued ?? applied;
  let daysOpen = null;
  if (open && start) {
    const elapsed = Date.now() - Date.parse(`${start}T00:00:00Z`);
    if (Number.isFinite(elapsed) && elapsed >= 0) daysOpen = Math.floor(elapsed / 86_400_000);
  } else if (!open && start && co) {
    const elapsed = Date.parse(`${co}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`);
    if (Number.isFinite(elapsed) && elapsed >= 0) daysOpen = Math.floor(elapsed / 86_400_000);
  }
  return {
    permit_number: toText(feature.Permit_Number),
    alternate_key: toText(feature.Alternate_Key),
    parcel_id: toText(feature.Parcel_ID),
    permit_type: toText(feature.Permit_Type).toUpperCase(),
    permit_desc: toText(feature.Permit_Desc) || null,
    permit_status: toText(feature.Permit_Status).toUpperCase(),
    applied_date: applied,
    approved_date: esriEpochToIsoDate(feature.PermitApproved_Date),
    issued_date: issued,
    co_date: co,
    last_modified: esriEpochToIsoDate(feature.Permit_LastModDate),
    permit_url: toText(feature.PermitURL) || null,
    is_roofing: isRoofingPermit(feature),
    is_open: open,
    days_open: daysOpen,
  };
}

/**
 * Build the incremental where clause for a permit refresh window.
 * `Permit_LastModDate` is the only field that moves when an existing permit
 * changes status, so it is the correct incremental key.
 *
 * The field is typed as a date on the service even though features return it
 * as epoch milliseconds. Comparing it against a raw epoch number is rejected
 * with `Failed to execute query`; it needs a SQL timestamp literal. Measured
 * against the live layer: a four-day window returns 304 permits.
 *
 * @param {Date | null} since - Lower bound, exclusive. Null requests a full scan.
 * @returns {string} A CD Plus where clause.
 */
export function permitWindowClause(since) {
  if (since === null) return "1=1";
  if (!Number.isFinite(since.getTime())) throw new Error("since must be a valid Date");
  const literal = since.toISOString().slice(0, 19).replace("T", " ");
  return `Permit_LastModDate > timestamp '${literal}'`;
}
