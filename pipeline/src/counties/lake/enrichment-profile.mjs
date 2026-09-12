/**
 * Lake County, FL enrichment profile: Sunbiz ZIP boundary, BBB category
 * scope, the published query-table schema, and the Filebase publication
 * targets.
 *
 * Two entries here are declarations of scope, not of work performed, and the
 * distinction matters for honest completeness:
 *
 * - `sunbiz.zipPrefixes` records the county's ZIP boundary because the
 *   profile schema requires it. The Sunbiz corporate ingest is **not** in
 *   this assignment's acceptance criteria and was not run; business records
 *   come from the DOR TPP roll instead.
 * - `bbb.categories` records the reviewed category paths a BBB harvest would
 *   target. The default route returned HTTP 403. A prohibited browser-
 *   fingerprint spoof returned 200 once, but no result was retained or
 *   ingested; the kit requires the 403 to remain a stop and an approved
 *   official-API route to be used. No such route is configured. The query table
 *   therefore carries `bbb_rating` as a real column that stays null, with the
 *   reason in `enrichment_status`.
 *
 * The single-IPNS deviation is recorded in `docs/lake-kit-deviations.md`:
 * the Filebase free plan allows exactly one IPNS name, so the query-table
 * and coverage labels below both resolve through the one owned name
 * (`oracle-open-data-lake`) as paths beneath the published run root, rather
 * than through three independent labels as the kit assumes.
 *
 * @module counties/lake/enrichment-profile
 */

import { validateEnrichmentProfile } from "../enrichment-profile.mjs";
import { LAKE_QUERY_TABLE_SCHEMA_FIELDS } from "./query-table.mjs";

/** The single IPNS label the Filebase free plan allows, already provisioned. */
export const LAKE_IPNS_LABEL = "oracle-open-data-lake";
/** Existing network key. Publication must never create or substitute a name. */
export const LAKE_IPNS_NETWORK_KEY =
  "k51qzi5uqu5dgd1ekyyuhwggov571fjxof2p5ef4ke7enlq60k03r47fosb2un";
/** The provisioned Filebase bucket for this county. */
export const LAKE_BUCKET = "elephant-oracle-open-data-lake";

export const lakeEnrichmentProfile = validateEnrichmentProfile({
  countyKey: "lake",
  countyName: "Lake",
  stateCode: "FL",
  sunbiz: {
    zipPrefixes: ["327", "347", "346", "348", "321", "322", "325", "328"],
  },
  bbb: {
    categories: [
      {
        key: "roofing-contractors",
        url: "https://www.bbb.org/us/fl/leesburg/category/roofing-contractors",
        reviewedPath: "/us/fl/leesburg/category/roofing-contractors",
      },
      {
        key: "heating-and-air-conditioning",
        url: "https://www.bbb.org/us/fl/leesburg/category/heating-and-air-conditioning",
        reviewedPath: "/us/fl/leesburg/category/heating-and-air-conditioning",
      },
    ],
  },
  queryTable: {
    schemaFields: { ...LAKE_QUERY_TABLE_SCHEMA_FIELDS },
  },
  publication: {
    bucket: LAKE_BUCKET,
    queryTableIpnsLabel: LAKE_IPNS_LABEL,
    coverageIpnsLabel: LAKE_IPNS_LABEL,
  },
});
