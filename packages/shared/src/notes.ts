/**
 * Long-form explanatory copy, in ONE place.
 *
 * The REST API ships a `note` with the business and contractor views, and the
 * browser answers the same questions locally with no server to ask. Both used to
 * carry their own copy of the wording, with a comment in each promising they
 * were identical. They stopped being identical the moment one was corrected: the
 * measured business-coverage caveat landed in the API and the README while the
 * browser — which is the default data path, and therefore what a reader actually
 * sees — kept serving the old text beside the inflated total.
 *
 * They live here so there is nothing to keep in sync. These are statements about
 * method and source gating; every figure on screen is queried, never typed.
 */

/** Business view: what a TPP account is, and the two limits on the totals. */
export const BUSINESS_VIEW_NOTE =
  "The business signal is the DOR tangible-personal-property (TPP) roll: an account is a business that reports taxable equipment at this situs address. It is evidence of business activity at the parcel, not a business directory, and it carries no company name, licence or registration. `has_sunbiz_tenant` is false for every row because Florida Sunbiz search answers HTTP 403 to this egress and was not ingested for this run. Two limits on the totals. The TPP roll carries no parcel key, so the join is a normalized street+zip match: 2,060 of the roll's 33,346 accounts (6.2%) match a parcel, and the rest are not published. And a matched address group is attributed to every parcel sharing that address, so summing business_account_count across parcels gives 4,451 rather than 2,060 - 90 address groups covering 180 accounts span 1,214 parcels. Read that total as account-to-parcel matches, not as a count of businesses. NAICS is not carried into the published table, so the roll's 44 roofing contractors are not queryable here.";

/** Contractor view: why two published columns are permanently null. */
export const CONTRACTOR_VIEW_NOTE =
  "Permit counts, roofing-permit counts and open-permit durations come from the Lake County CD Plus permit layer joined to the tax roll on Alternate_Key. Contractor identity and BBB reputation are not in that layer: they live behind sources that answer HTTP 403. Those columns are published and stay null rather than being filled with a guess.";

/** Tokens the pipeline writes into `enrichment_status` for the gated sources. */
export const GATED_ENRICHMENT_TOKENS = "contractor_gated_403;bbb_gated_403";
