/**
 * Long-form explanatory copy that the browser data source has to supply itself.
 *
 * The REST API ships a `note` with the business and contractor views. When the
 * browser answers the same question locally there is no server to ask, so the
 * identical wording lives here. These are statements about method and source
 * gating — never numbers; every figure on screen is queried.
 */

export const BUSINESS_VIEW_NOTE =
  "The business signal is the DOR tangible-personal-property (TPP) roll: an account is a business that reports taxable equipment at this situs address. It is evidence of business activity at the parcel, not a business directory, and it carries no company name, licence or registration. `has_sunbiz_tenant` is false for every row because Florida Sunbiz search answers HTTP 403 to this egress and was not ingested for this run.";

export const CONTRACTOR_VIEW_NOTE =
  "Permit counts, roofing-permit counts and open-permit durations come from the Lake County CD Plus permit layer joined to the tax roll on Alternate_Key. Contractor identity and BBB reputation are not in that layer: they live behind sources that answer HTTP 403. Those columns are published and stay null rather than being filled with a guess.";

/** Tokens the pipeline writes into `enrichment_status` for the gated sources. */
export const GATED_ENRICHMENT_TOKENS = "contractor_gated_403;bbb_gated_403";
