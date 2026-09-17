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
  "The business signal is the DOR tangible-personal-property (TPP) roll: an account records taxable equipment reported at a situs address. It is evidence of reported business activity, not a verified legal-company directory. `has_sunbiz_tenant` remains null because corporate identity was not established — null rather than false, because absence was never proven. The bulk data-download portal used by sunbiz-corporate-ingest was Cloudflare-challenged on the approved route; Sunbiz's own name search is a different channel, not the bulk ingest route. Official Sunbiz and dated DBPR identity records remain prerequisites for verified permit-to-company attribution, not an owner-waived exclusion. The TPP roll carries no parcel key, so property associations use normalized street+ZIP candidates. A matched address group is attributed to every parcel sharing that address; read the runtime-derived total as account-to-parcel matches, not a count of distinct businesses. The account-grain business artifact, when available in the selected run, retains all source accounts, including valid unmatched accounts; an absent artifact in an older release is not a zero-business result. NAICS codes and account names are carried as business_naics_codes, business_names and roofing_business_count per parcel. A roofing-business address match says equipment was reported at an address, not that it worked on the parcel. Source-listed contractor names from Clermont permit details are a separate observation, not proof of legal identity or a verified license.";

/**
 * Contractor view: one column that is null everywhere, one that is null in
 * fourteen jurisdictions of fifteen, and why each is what it is.
 *
 * This note used to say both columns were permanently null. Clermont's eTRAKiT
 * portal publishes a contractor of record and is now harvested, so that
 * sentence became an understatement of the data actually published - the same
 * class of error, in the opposite direction, as presenting a gated null as
 * proof that nobody worked on a property.
 */
export const CONTRACTOR_VIEW_NOTE =
  "The retained permit sources are Lake County CD Plus and Clermont eTRAKiT. CD Plus joins to the tax roll on Alternate_Key but carries no contractor field. Clermont permit detail pages supply source-listed contractor names within one of Lake County's fifteen jurisdictions; never read a non-zero contractor count as county-wide coverage or verified legal identity. A verified company/license relationship requires official Sunbiz and temporally adequate DBPR records, which this source-only snapshot does not establish. Current/open status, completion and open duration remain unavailable in the source-only preview; historical status text is an observation, not a current decision. Missing contractor text does not prove a permit was unassigned. Older enrichment_status labels such as contractor_gated_403 and contractor_absent_on_permit are legacy annotations, not a substitute for a successful, contractor-capable detail lookup proving absence. The county permit detail pages returned HTTP 403 on approved routes, while other jurisdiction limitations remain in coverage. BBB is a policy boundary, not technical impossibility: the default request/browser route returned 403 and robots.txt disallows crawling the query-string URLs. No approved official BBB API route is configured; no fingerprint, proxy or egress evasion is permitted. The prohibited desktop-user-agent probe returned 200 but no BBB data was retained or ingested. bbb_rating stays null rather than being guessed. TPP NAICS codes, account names and roofing-business address associations remain separate business observations, not evidence that a named business worked on a permit.";

/**
 * Tokens the pipeline writes into `enrichment_status` for the gated sources.
 *
 * This is the county-level pair, used where a view has to explain the two
 * columns with no row to read the answer off. It describes the fourteen
 * jurisdictions that publish no contractor, not a Clermont parcel, whose row
 * carries `contractor_from_clermont_etrakit` or `contractor_absent_on_permit`
 * instead. Never derive a per-parcel explanation from it.
 */
export const GATED_ENRICHMENT_TOKENS = "contractor_gated_403;bbb_gated_403";
