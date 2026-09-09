/**
 * Serialise `SearchOptions` into the query string the REST API documents.
 *
 * Kept separate from the API data source so the search view can also build a
 * shareable querystring, and so the boolean encoding (`"true"`/`"false"`, never
 * `"1"`) lives in exactly one place.
 */

import type { SearchOptions } from "@oracle-lake/shared";

const NUMBER_KEYS = [
  "minRoofAge",
  "maxRoofAge",
  "minOpenPermitDays",
  "minMarketValue",
  "maxMarketValue",
  "minBuiltYear",
  "maxBuiltYear",
  "lat",
  "lon",
  "radiusMiles",
  "limit",
  "offset",
] as const;

const STRING_KEYS = ["q", "city", "zip", "propertyType", "roofAgeBasis", "sortBy", "sortDir"] as const;

const BOOLEAN_KEYS = [
  "hasPermits",
  "hasOpenRoofingPermit",
  "ownerOutOfCounty",
  "ownerOutOfState",
  "noRecordedSale",
  "hasBusinessAccount",
  "requireCoordinates",
] as const;

/** Build `URLSearchParams` carrying only the options that are actually set. */
export function toSearchParams(options: SearchOptions): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of STRING_KEYS) {
    const value = options[key];
    if (typeof value === "string" && value.trim().length > 0) params.set(key, value.trim());
  }
  for (const key of NUMBER_KEYS) {
    const value = options[key];
    if (typeof value === "number" && Number.isFinite(value)) params.set(key, String(value));
  }
  for (const key of BOOLEAN_KEYS) {
    const value = options[key];
    if (typeof value === "boolean") params.set(key, value ? "true" : "false");
  }
  return params;
}
