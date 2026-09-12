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
  "The business signal is the DOR tangible-personal-property (TPP) roll: an account is a business that reports taxable equipment at this situs address. It is evidence of business activity at the parcel, not a business directory. `has_sunbiz_tenant` is null for every row because Sunbiz corporate data was not ingested — null rather than false, because absence was never established: the bulk data-download portal the kit's sunbiz-corporate-ingest skill uses is Cloudflare-challenged from here, and corporate registration is outside this assignment's acceptance criteria. Sunbiz's own name search is reachable and is not the ingest channel, so saying it was blocked would be wrong. The TPP roll carries no parcel key, so its join uses normalized street+ZIP and cannot publish source accounts without a matching assessed parcel. A matched address group is attributed to every parcel sharing that address; read the runtime-derived total as account-to-parcel matches, not as a count of distinct businesses. NAICS codes and account names from the TPP roll are carried as business_naics_codes, business_names and roofing_business_count per parcel. A roofing-business match is a contractor-shaped signal that says a roofing business reports equipment at an address, not that it worked on the parcel. It is not the same signal as contractor of record, which comes from Clermont's permit portal and only for Clermont.";

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
  "Permit counts, roofing-permit counts and open-permit durations come from the Lake County CD Plus permit layer joined to the tax roll on Alternate_Key. That layer carries no contractor field at all, so contractor identity has to come from a permitting jurisdiction's own portal, and exactly one of Lake County's fifteen jurisdictions serves one to this egress: Clermont, whose eTRAKiT permit detail pages publish the contractor of record and are harvested. contractor_name is therefore populated on Clermont parcels that join the assessed roll and null on the rest of the county — never read a non-zero contractor count on this page as county-wide coverage. Where the column is null, enrichment_status says which kind of null it is: contractor_gated_403 where no source covering that parcel publishes a contractor at all, because the county's own permit detail pages answer HTTP 403 behind a Cloudflare challenge to every method tried including a real browser, and thirteen of the other fourteen municipalities are blocked, unavailable or manual-only; contractor_absent_on_permit where Clermont did publish the parcel's permits and none of them named anybody. BBB is a policy boundary rather than a claim of technical impossibility: its default request/browser route returned 403, robots.txt disallows crawling the query-string URLs, and the kit's bbb-harvest skill requires that response to remain a stop and access to be requested through the official BBB API — explicitly forbidding changes to egress, proxies or browser fingerprints. One prohibited desktop-user-agent spoof returned 200 during verification; no result was retained or ingested, and no approved official-API route is configured. bbb_rating is published and stays null on every row rather than being filled with a guess. What IS published beside it is the TPP roll's own view of business activity at a parcel — NAICS codes, account names, and a roofing-business count — which may name a roofing business by address without asserting it worked on anything.";

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
