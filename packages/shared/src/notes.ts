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
  "The business signal is the DOR tangible-personal-property (TPP) roll: an account is a business that reports taxable equipment at this situs address. It is evidence of business activity at the parcel, not a business directory, and it carries no company name, licence or registration. `has_sunbiz_tenant` is null for every row because Sunbiz corporate data was not ingested — null rather than false, because absence was never established: the bulk data-download portal the kit's sunbiz-corporate-ingest skill uses is Cloudflare-challenged from here, and corporate registration is outside this assignment's acceptance criteria. Sunbiz's own name search is reachable and is not the ingest channel, so saying it was blocked would be wrong. Two limits on the totals. The TPP roll carries no parcel key, so the join is a normalized street+zip match: 2,060 of the roll's 33,346 accounts (6.2%) match a parcel, and the rest are not published. And a matched address group is attributed to every parcel sharing that address, so summing business_account_count across parcels gives 4,451 rather than 2,060 - 90 address groups covering 180 accounts span 1,214 parcels. Read that total as account-to-parcel matches, not as a count of businesses. NAICS codes and account names ARE now carried: business_naics_codes, business_names and roofing_business_count are published per parcel. Of the roll's 44 roofing contractors (NAICS 238160), the 10 whose situs address matches a parcel appear by name — the only contractor-shaped signal obtainable from a published source, since the county's own permit pages hide contractor of record behind a 403.";

/** Contractor view: why two published columns are permanently null. */
export const CONTRACTOR_VIEW_NOTE =
  "Permit counts, roofing-permit counts and open-permit durations come from the Lake County CD Plus permit layer joined to the tax roll on Alternate_Key. Contractor identity and BBB reputation are not in that layer, and the two are blocked for different reasons. Contractor of record lives on Lake County permit detail pages, which answer HTTP 403 behind a Cloudflare challenge to every method tried, including a real browser. BBB is a policy boundary rather than a technical one: bbb.org's robots.txt disallows crawling its query-string URLs, and the kit's bbb-harvest skill requires that a 403 be treated as a stop and access requested through the official BBB API — explicitly forbidding changes to egress, proxies or browser fingerprints to get around it. A profile page will load in a browser; harvesting it that way is the thing we are told not to do. Both columns are published and stay null rather than being filled with a guess. What IS published is the TPP roll's own view of business activity at a parcel — NAICS codes, account names, and a roofing-business count — which names 10 roofing contractors by address without asserting they worked on anything.";

/** Tokens the pipeline writes into `enrichment_status` for the gated sources. */
export const GATED_ENRICHMENT_TOKENS = "contractor_gated_403;bbb_gated_403";
