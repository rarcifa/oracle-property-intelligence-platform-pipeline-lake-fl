/**
 * Honest-completeness helpers.
 *
 * `contractor_name` and `bbb_rating` are real columns that are always null
 * because the sources answer HTTP 403. The UI must never render those as blank
 * cells; it must render the reason. These helpers turn the pipeline's
 * `enrichment_status` tokens into that reason, so the explanation is derived
 * from the row rather than hardcoded in a component.
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
      "Contractor identity lives on county permit detail pages behind a Cloudflare managed challenge across the whole lakecountyfl.gov estate, which answers HTTP 403 to every egress tested. contractor_name is a real column that stays null rather than being fabricated.",
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
  contractor_name:
    "Gated at source: county permit detail pages answer HTTP 403 (Cloudflare managed challenge).",
  bbb_rating: "Gated at source: bbb.org answers HTTP 403 to this egress.",
  has_bbb_contractor:
    "Always null: BBB enrichment is gated at source, so absence was never established.",
  has_sunbiz_tenant:
    "Always null: Sunbiz corporate data was not ingested, so absence was never established.",
  property_cid:
    "Not populated by this run; the run publishes a single columnar table, not per-property CIDs.",
});

/**
 * Tenure honesty: `no_recorded_sale_in_dor_window` is a lower bound, not proof
 * of long tenure, because only the current DOR roll is published.
 */
export const TENURE_CAVEAT =
  "The published DOR roll carries only 2025-2026 sales, and the historical DOR map-data files carry parcel geometry only. 'No recorded sale' is a lower bound on tenure, not a tenure claim.";
