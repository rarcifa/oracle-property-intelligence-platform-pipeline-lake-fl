/**
 * Honest-completeness helpers.
 *
 * `bbb_rating` is a real column that is always null because the source answers
 * HTTP 403. `contractor_name` is the harder case: it is populated for the one
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
  readonly severity: "gated" | "absent" | "present";
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
      "Clermont's eTRAKiT portal names the contractor on its permit detail pages, and this parcel's permits were harvested from it. The name shown is the contractor on the most recently dated permit, not the only contractor who has worked here.",
  },
  contractor_absent_on_permit: {
    field: "contractor_name",
    severity: "absent",
    headline: "No contractor named on the permit",
    detail:
      "This parcel's permits were harvested from Clermont's eTRAKiT portal, which does publish a contractor of record, and none of them named one - an owner-builder permit, for example. This is an established absence rather than a gated field.",
  },
  bbb_gated_403: {
    field: "bbb_rating",
    severity: "gated",
    headline: "BBB rating is gated at the source",
    detail:
      "bbb.org answers HTTP 403 to this egress, and BBB browser work requires approved remote compute that this no-ongoing-cost deployment does not have. bbb_rating is a real column that stays null rather than being fabricated.",
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
        severity: "absent" as const,
        headline: token,
        detail: "Unrecognised enrichment status token, reported verbatim from the published row.",
      };
    });
}

/** The subset of notices that explain a null column. */
export function gatedFieldNotices(status: string | null | undefined): GatingNotice[] {
  return parseEnrichmentStatus(status).filter((notice) => notice.severity === "gated");
}

/** Column-level gating explanations, keyed by column name. */
export const ALWAYS_NULL_COLUMNS: Readonly<Record<string, string>> = Object.freeze({
  bbb_rating: "Gated at source: bbb.org answers HTTP 403 to this egress.",
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
    "Populated for Clermont only, the one Lake County jurisdiction of fifteen whose permit portal publishes a contractor of record. Null elsewhere; enrichment_status says whether that null is gated or an established absence.",
});

/**
 * Tenure honesty: `no_recorded_sale_in_dor_window` is a lower bound, not proof
 * of long tenure, because only the current DOR roll is published.
 */
export const TENURE_CAVEAT =
  "The published DOR roll carries only 2025-2026 sales, and the historical DOR map-data files carry parcel geometry only. 'No recorded sale' is a lower bound on tenure, not a tenure claim.";
