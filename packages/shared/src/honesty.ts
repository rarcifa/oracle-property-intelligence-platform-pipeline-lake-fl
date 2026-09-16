/**
 * Honest-completeness helpers.
 *
 * `bbb_rating` is a real column that is always null because no approved BBB API
 * harvest was run. `contractor_name` is the harder case: it is populated for the one
 * Lake jurisdiction whose permit portal publishes a contractor (Clermont) and
 * null for the other fourteen, so a blank cell means one of three different
 * things and the row itself has to say which. The UI must never render any of
 * them as an empty cell; it must render the reason. These helpers turn the
 * pipeline's `enrichment_status` tokens into that reason, so the explanation
 * is derived from the row rather than hardcoded in a component.
 */

export interface GatingNotice {
  readonly token: string;
  readonly field: string | null;
  readonly severity: "gated" | "absent" | "present" | "unknown";
  readonly headline: string;
  readonly detail: string;
}

const NOTICES: Readonly<Record<string, Omit<GatingNotice, "token">>> = Object.freeze({
  permits_loaded: {
    field: null,
    severity: "present",
    headline: "Permits loaded",
    detail:
      "Permit records for this parcel came from the Lake County CD Plus permit layer, joined on Alternate_Key.",
  },
  no_permits_in_source: {
    field: null,
    severity: "absent",
    headline: "No permits in source",
    detail:
      "The CD Plus layer published no permit for this parcel. That layer carries a rolling 365-day Permit_LastModDate window and covers unincorporated Lake County only, so absence here is not proof that no permit exists.",
  },
  contractor_gated_403: {
    field: "contractor_name",
    severity: "gated",
    headline: "Contractor of record is gated at the source",
    detail:
      "No source that covers this parcel publishes a contractor. The CD Plus layer carries no contractor field, county permit detail pages sit behind a Cloudflare managed challenge across the whole lakecountyfl.gov estate that answers HTTP 403 to every egress tested, and thirteen of the fourteen municipalities are blocked, unavailable or manual-only. contractor_name is a real column that stays null rather than being fabricated.",
  },
  contractor_from_clermont_etrakit: {
    field: "contractor_name",
    severity: "present",
    headline: "Contractor of record published",
    detail:
      "Clermont's eTRAKiT portal lists a contractor name. The most recently dated permit supplies this display name, not a verified legal company or license identity and not every contractor who has worked here.",
  },
  contractor_absent_on_permit: {
    field: "contractor_name",
    severity: "unknown",
    headline: "Contractor absence is not proven",
    detail:
      "This legacy token describes a missing source name. It does not prove a successful, contractor-capable detail lookup returned an empty assignment. Do not treat it as an unassigned lead or established absence.",
  },
  bbb_gated_403: {
    field: "bbb_rating",
    severity: "gated",
    headline: "BBB rating is gated at the source",
    detail:
      "BBB's default request/browser route returned HTTP 403. One prohibited browser-fingerprint spoof returned 200 during verification, so this is a policy/API boundary rather than proof the site is unreachable. No BBB result was retained or ingested, and no approved official-API route is configured; bbb_rating stays null rather than being fabricated.",
  },
  retained_source_observations: {
    field: null,
    severity: "present",
    headline: "Retained source observations",
    detail:
      "Historical observations are retained, not accepted as current permit decisions or complete county history.",
  },
  current_permit_status_not_revalidated: {
    field: "open_roofing_permit_count",
    severity: "unknown",
    headline: "Current permit status unknown",
    detail:
      "Captured status was not revalidated under an accepted source/freshness contract. Open counts and durations remain unknown, not zero.",
  },
  primary_roof_completion_needs_review: {
    field: "roof_age_years",
    severity: "unknown",
    headline: "Built-year proxy only",
    detail:
      "Permit-backed primary-roof completion is unaccepted. A valid built year supplies only a low-confidence proxy; partial history may omit a later replacement.",
  },
  contractor_source_name_only: {
    field: "contractor_name",
    severity: "present",
    headline: "Source-listed contractor name only",
    detail: "A displayed source name is not verified company, qualifier or license identity.",
  },
  contractor_absence_not_proven: {
    field: "contractor_name",
    severity: "unknown",
    headline: "Contractor assignment unknown",
    detail: "Missing contractor data does not prove an unassigned permit or confirmed absence.",
  },
  sunbiz_temporal_dbpr_required: {
    field: null,
    severity: "gated",
    headline: "Official identity evidence required",
    detail:
      "Loaded, reconciled Sunbiz and dated official DBPR relationships are required before verified legal-company attribution.",
  },
  bbb_policy_api_gated: {
    field: "bbb_rating",
    severity: "gated",
    headline: "BBB enrichment unavailable",
    detail:
      "No approved BBB enrichment was ingested; missing ratings do not prove a negative rating or no contractor.",
  },
});

/** Turn an `enrichment_status` value into the notices it encodes. */
export function parseEnrichmentStatus(status: string | null | undefined): GatingNotice[] {
  if (!status) return [];
  return status
    .split(";")
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .map((token) => {
      const known = NOTICES[token];
      if (known) return { token, ...known };
      return {
        token,
        field: null,
        severity: "unknown" as const,
        headline: token,
        detail: "Unrecognised enrichment status token, reported verbatim from the published row.",
      };
    });
}

/** The subset of notices that explain a null column. */
export function gatedFieldNotices(status: string | null | undefined): GatingNotice[] {
  return parseEnrichmentStatus(status).filter(
    (notice) => notice.severity === "gated" || notice.severity === "unknown",
  );
}

/** Column-level gating explanations, keyed by column name. */
export const ALWAYS_NULL_COLUMNS: Readonly<Record<string, string>> = Object.freeze({
  bbb_rating:
    "Policy/API gated: the default BBB route returned HTTP 403 and no approved official-API harvest was run.",
  has_bbb_contractor:
    "Always null: BBB enrichment is gated at source, so absence was never established.",
  has_sunbiz_tenant:
    "Always null: Sunbiz corporate data was not ingested, so absence was never established.",
  property_cid:
    "Not populated by this run; the run publishes a single columnar table, not per-property CIDs.",
});

/**
 * Columns populated for part of the county and null for the rest, with the
 * boundary stated. These are NOT in {@link ALWAYS_NULL_COLUMNS}: calling a
 * partially-populated column "always null" understates it exactly as badly as
 * calling a gated column "no contractor" overstates it.
 */
export const PARTIALLY_POPULATED_COLUMNS: Readonly<Record<string, string>> = Object.freeze({
  contractor_name:
    "Source-listed names for Clermont only, one of fifteen Lake County jurisdictions. Null elsewhere; a missing name is not established absence or a verified legal identity.",
});

/**
 * Tenure honesty: `no_recorded_sale_in_dor_window` is a lower bound, not proof
 * of long tenure within the inspected DOR evidence; other published history
 * must be evaluated separately rather than declared absent.
 */
export const TENURE_CAVEAT =
  "The loaded and inspected DOR evidence covers 2025-2026 sales only. 'No recorded sale' is a lower bound on tenure, not a ten-year tenure claim. The Lake property appraiser advertises historical sales exports; they are not loaded or accepted as a complete chain of title here.";
