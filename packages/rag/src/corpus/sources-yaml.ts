/**
 * The source catalog (`lake-sources.yaml`) turned into retrievable documents.
 *
 * This file is the county's machine-readable statement of what was reached,
 * what was not, and who to ask for the rest. It is also the only place the
 * fifteen permit jurisdictions are described, which makes it the answer to the
 * hardest class of question this corpus exists for: "which jurisdictions are
 * blocked and how do I request their records".
 *
 * The YAML is validated with Zod on the way in, so a catalog change that breaks
 * the corpus fails the build instead of silently producing empty documents.
 */

import { z } from "zod";
import { entityChunk, count } from "./entity.js";
import type { CorpusChunk, CorpusLink, Provenance } from "../types.js";

const recordsRequestSchema = z.object({
  recipient_office: z.string().nullish(),
  request_portal_url: z.string().nullish(),
  request_email: z.string().nullish(),
  system_scope: z.string().nullish(),
  route: z.string().nullish(),
});

const jurisdictionSchema = z.object({
  jurisdiction: z.string(),
  key: z.string(),
  status: z.string(),
  vendor: z.string().nullish(),
  portal_kind: z.string().nullish(),
  portal: z.string().nullish(),
  predecessor_portal: z.string().nullish(),
  historical_records: z.boolean().nullish(),
  anonymous_access: z.boolean().nullish(),
  adapter: z.string().nullish(),
  implementation_status: z.string().nullish(),
  parcel_search: z.string().nullish(),
  enumeration_status: z.string().nullish(),
  throughput: z.string().nullish(),
  probe: z.string().nullish(),
  known_exclusions: z.string().nullish(),
  records_request: recordsRequestSchema.nullish(),
});

export const sourcesYamlSchema = z.object({
  county: z.string(),
  state: z.string(),
  slug: z.string(),
  fips: z.string(),
  snapshot_time: z.string().nullish(),
  parcel: z.object({
    canonical_source: z.string(),
    assessed_parcel_count: z.number(),
    gis_feature_count: z.number().nullish(),
    count_difference: z.number().nullish(),
    count_difference_pct: z.number().nullish(),
    discrepancy_explanation: z.string().nullish(),
    identifier_name: z.string().nullish(),
    identifier_format: z.string().nullish(),
    join_rule: z.string().nullish(),
    measured_coverage: z.record(z.number()).nullish(),
  }),
  sales: z.object({
    source: z.string(),
    record_count: z.number().nullish(),
    parcels_with_a_sale: z.number().nullish(),
    window_first: z.union([z.string(), z.number()]).nullish(),
    window_last: z.union([z.string(), z.number()]).nullish(),
    ten_year_tenure_provable: z.boolean().nullish(),
    ten_year_tenure_evidence: z.string().nullish(),
  }),
  permits: z.object({
    expected_jurisdiction_count: z.number().nullish(),
    countywide_record_count: z.number().nullish(),
    countywide_layer_record_count: z.number().nullish(),
    countywide_distinct_permit_count: z.number().nullish(),
    countywide_distinct_parcel_count: z.number().nullish(),
    roofing_permit_count: z.number().nullish(),
    open_permit_count: z.number().nullish(),
    open_roofing_permit_count: z.number().nullish(),
    roofing_permit_types: z.array(z.string()).nullish(),
    open_permit_statuses: z.array(z.string()).nullish(),
    coverage_finding: z.string().nullish(),
    jurisdictions: z.array(jurisdictionSchema),
  }),
  business: z.object({
    source: z.string(),
    account_count: z.number().nullish(),
    construction_naics_count: z.number().nullish(),
    roofing_naics_238160_count: z.number().nullish(),
    note: z.string().nullish(),
  }),
  source_inventory: z.record(z.string()).nullish(),
  access_states: z
    .object({
      cloudflare_challenged: z
        .object({
          hosts: z.array(z.string()),
          evidence: z.string().nullish(),
          consequence: z.string().nullish(),
        })
        .nullish(),
      correction_to_prior_findings: z.string().nullish(),
    })
    .nullish(),
  publication: z
    .object({
      ipns_label: z.string().nullish(),
      ipns_name: z.string().nullish(),
      single_ipns_deviation: z.string().nullish(),
    })
    .nullish(),
  enrichment: z
    .object({
      bbb: z.object({ status: z.string().nullish(), blocker: z.string().nullish() }).nullish(),
      contractor_identity: z
        .object({ status: z.string().nullish(), blocker: z.string().nullish() })
        .nullish(),
    })
    .nullish(),
});

export type SourcesYaml = z.infer<typeof sourcesYamlSchema>;
export type Jurisdiction = z.infer<typeof jurisdictionSchema>;

/**
 * Whether a jurisdiction's permits are actually in the published dataset.
 *
 * `status: supported` is not the same thing as harvested. Clermont is
 * catalogued as supported because its portal is open and machine-readable, but
 * its `implementation_status` is `discovered`: no adapter was built and none of
 * its permits were fetched. Reading status alone would generate a document
 * claiming Clermont's permits are published, which is exactly the kind of
 * confident falsehood this corpus exists to prevent.
 */
function isHarvested(jurisdiction: Jurisdiction): boolean {
  return jurisdiction.status === "supported" && jurisdiction.implementation_status === "certified";
}

/** Plain-language reading of a jurisdiction's machine status. */
function statusSentence(jurisdiction: Jurisdiction): string {
  if (jurisdiction.status === "supported") {
    return isHarvested(jurisdiction)
      ? "This jurisdiction IS harvested: its permit data is in the published dataset."
      : "This jurisdiction's portal is OPEN and machine-readable, but it has NOT been harvested: no adapter was built for it, so none of its permits are in the published dataset. It is catalogued as a discovered source, not a loaded one.";
  }
  switch (jurisdiction.status) {
    case "blocked":
      return "This jurisdiction is BLOCKED: its permit portal exists but cannot be read by an automated client from this egress, so none of its permits are in the published dataset.";
    case "unavailable":
      return "This jurisdiction is UNAVAILABLE: its permit portal could not be reached at all from this egress, so none of its permits are in the published dataset.";
    case "manual-only":
      return "This jurisdiction is MANUAL-ONLY: it publishes no searchable permit history online at all, so none of its permits are in the published dataset.";
    default:
      return `Status: ${jurisdiction.status}.`;
  }
}

/** How to ask a jurisdiction for the records the pipeline could not read. */
function recordsRequestSentence(jurisdiction: Jurisdiction): string | null {
  const request = jurisdiction.records_request;
  if (!request) return null;
  const recipient =
    request.recipient_office ?? `the ${jurisdiction.jurisdiction} records custodian`;
  const channel = request.request_email
    ? `email ${request.request_email}`
    : request.request_portal_url
      ? `use the request portal at ${request.request_portal_url}`
      : "use the jurisdiction's published records-request channel";
  const portalNote =
    request.request_email && request.request_portal_url
      ? ` The records-request portal is ${request.request_portal_url}.`
      : "";
  return [
    `How to request these records: file a Florida public-records request under Chapter 119 with ${recipient} and ${channel}.${portalNote}`,
    request.system_scope ? `Ask specifically for: ${request.system_scope}.` : null,
    request.route ? `Route recorded in the catalog: ${request.route}.` : null,
  ]
    .filter((line): line is string => line !== null)
    .join(" ");
}

/** Build one document per permit jurisdiction, plus the jurisdiction overview. */
export function buildJurisdictionDocs(
  sources: SourcesYaml,
  provenance: Provenance,
): { chunks: CorpusChunk[]; links: CorpusLink[] } {
  const chunks: CorpusChunk[] = [];
  const links: CorpusLink[] = [];
  const permits = sources.permits;

  const harvested = permits.jurisdictions.filter(isHarvested);
  const missing = permits.jurisdictions.filter((entry) => !isHarvested(entry));
  const overviewId = "jurisdiction:overview";

  chunks.push(
    entityChunk({
      docId: overviewId,
      docType: "jurisdiction",
      title:
        "Permit jurisdictions in Lake County, Florida — who issues permits and which ones are blocked",
      lines: [
        `Lake County permitting is not a single countywide system. There are ${count(permits.expected_jurisdiction_count)} permit-issuing jurisdictions: unincorporated Lake County plus ${permits.jurisdictions.length - 1} independent municipalities, each running its own building department and its own permit software.`,
        `Exactly ${harvested.length === 1 ? "one jurisdiction is" : `${harvested.length} jurisdictions are`} harvested into the published dataset: ${harvested.map((entry) => entry.jurisdiction).join(", ")}, through the Perconti CD Plus permit layer. The other ${missing.length} are blocked, unavailable, manual-only, or open but never harvested.`,
        `Jurisdictions that are NOT in the published data: ${missing.map((entry) => `${entry.jurisdiction} (${entry.status === "supported" ? "open portal, not harvested" : entry.status}, ${entry.enumeration_status ?? "no enumeration route"})`).join("; ")}.`,
        `Every blocked jurisdiction has a named public-records request recipient in the source catalog, so the records can still be obtained by a Chapter 119 request. Ask for the jurisdiction by name to get its recipient office, request channel and system scope.`,
        permits.coverage_finding ? `Measured coverage finding: ${permits.coverage_finding}` : null,
        permits.roofing_permit_types
          ? `Roofing permit types in the county layer: ${permits.roofing_permit_types.join(", ")}. Open permit statuses: ${(permits.open_permit_statuses ?? []).join(", ")}.`
          : null,
      ],
      aliases: [
        "permit jurisdictions",
        "which jurisdictions are blocked",
        "permit authority",
        "municipalities",
      ],
      metadata: { family: "permits", county: sources.county },
      provenance,
    }),
  );

  for (const jurisdiction of permits.jurisdictions) {
    const docId = `jurisdiction:${jurisdiction.key}`;
    chunks.push(
      entityChunk({
        docId,
        docType: "jurisdiction",
        title: `${jurisdiction.jurisdiction} — permit jurisdiction in Lake County, Florida`,
        lines: [
          statusSentence(jurisdiction),
          jurisdiction.vendor ? `Permit system vendor: ${jurisdiction.vendor}.` : null,
          jurisdiction.portal
            ? `Permit portal: ${jurisdiction.portal} (${jurisdiction.portal_kind ?? "unclassified"}).`
            : null,
          jurisdiction.predecessor_portal
            ? `Predecessor system: ${jurisdiction.predecessor_portal}.`
            : null,
          `Historical permit records held by this jurisdiction: ${jurisdiction.historical_records ? "yes" : "no online history"}. Anonymous machine access: ${jurisdiction.anonymous_access ? "yes" : "no"}.`,
          `Harvest state: ${jurisdiction.implementation_status ?? "unknown"}; enumeration status ${jurisdiction.enumeration_status ?? "unknown"}; adapter ${jurisdiction.adapter ?? "none"}.`,
          jurisdiction.parcel_search ? `Parcel search: ${jurisdiction.parcel_search}.` : null,
          jurisdiction.throughput ? `Measured throughput: ${jurisdiction.throughput}.` : null,
          jurisdiction.probe ? `Probe result: ${jurisdiction.probe}` : null,
          jurisdiction.known_exclusions
            ? `What is missing and why: ${jurisdiction.known_exclusions}`
            : null,
          recordsRequestSentence(jurisdiction),
        ],
        aliases: [
          jurisdiction.jurisdiction,
          jurisdiction.key.replace(/-/g, " "),
          `${jurisdiction.jurisdiction} permits`,
          `${jurisdiction.jurisdiction} building department`,
        ],
        metadata: {
          family: "permits",
          jurisdiction: jurisdiction.jurisdiction,
          jurisdictionKey: jurisdiction.key,
          status: jurisdiction.status,
          vendor: jurisdiction.vendor ?? "none",
          harvested: String(isHarvested(jurisdiction)),
        },
        provenance,
      }),
    );
    links.push({
      sourceDocId: overviewId,
      targetDocId: docId,
      relation: "documents",
      metadata: { basis: "permit-jurisdiction-catalog", jurisdictionKey: jurisdiction.key },
    });
    if (jurisdiction.records_request) {
      links.push({
        sourceDocId: docId,
        targetDocId: "source:cdplus",
        relation: "requests_records_from",
        metadata: {
          basis: "chapter-119-route",
          jurisdictionKey: jurisdiction.key,
        },
      });
    }
  }

  return { chunks, links };
}

/** Build one document per upstream data source. */
export function buildSourceDocs(sources: SourcesYaml, provenance: Provenance): CorpusChunk[] {
  const inventory = sources.source_inventory ?? {};
  const parcel = sources.parcel;
  const sales = sources.sales;
  const business = sources.business;
  const permits = sources.permits;
  const coverage = parcel.measured_coverage ?? {};

  return [
    entityChunk({
      docId: "source:nal",
      docType: "source",
      title: "Data source: Florida DOR NAL 2026 preliminary tax roll (fl_dor_nal_2026p)",
      lines: [
        `The NAL roll is the canonical parcel source and the denominator for every coverage claim: ${count(parcel.assessed_parcel_count)} assessed parcels in Lake County.`,
        "It supplies address, owner name and mailing address, property and usage type, DOR use code, year built, livable area, building count, assessed / market / land / taxable value, and the two most recent sales carried on the roll.",
        `Measured field coverage: year built known on ${count(coverage.year_built_known)} parcels, physical ZIP on ${count(coverage.physical_zip_known)}, owner name on ${count(coverage.owner_name_known)}, ${count(coverage.distinct_owner_names)} distinct owner names, ${count(coverage.out_of_state_owners)} out-of-state owners.`,
        `Identifier: ${parcel.identifier_name ?? "DOR Parcel ID"}, format ${parcel.identifier_format ?? "unknown"}. Join rule: ${parcel.join_rule ?? "unknown"}`,
        "Limitation: only the current roll is published. There is no attribute-bearing historical roll before 2024F, so nothing on this source can prove ownership history.",
        `Bulk download portal: ${inventory.property_bulk ?? "https://floridarevenue.com/property/dataportal"}.`,
      ],
      aliases: [
        "NAL",
        "DOR NAL",
        "tax roll",
        "fl_dor_nal_2026p",
        "assessment roll",
        "florida department of revenue",
      ],
      metadata: { family: "sources", token: "fl_dor_nal_2026p", status: "ingested" },
      provenance,
    }),
    entityChunk({
      docId: "source:sdf",
      docType: "source",
      title: "Data source: Florida DOR SDF 2026 preliminary sales file (fl_dor_sdf_2026p)",
      lines: [
        `${sales.source}. ${count(sales.record_count)} sale records covering ${count(sales.parcels_with_a_sale)} parcels.`,
        `Sale window published: ${String(sales.window_first ?? "?")} to ${String(sales.window_last ?? "?")} only.`,
        `Ten-year ownership tenure provable from published sources: ${sales.ten_year_tenure_provable ? "yes" : "NO"}.`,
        sales.ten_year_tenure_evidence ? `Evidence: ${sales.ten_year_tenure_evidence}` : null,
        "Consequence for the query table: no_recorded_sale_in_dor_window is a lower bound on tenure, never a tenure length. A property with no sale in the window may have changed hands in 2019 and the published data cannot tell.",
      ],
      aliases: ["SDF", "sales file", "fl_dor_sdf_2026p", "sale records", "tenure"],
      metadata: { family: "sources", token: "fl_dor_sdf_2026p", status: "ingested" },
      provenance,
    }),
    entityChunk({
      docId: "source:tpp",
      docType: "source",
      title:
        "Data source: Florida DOR TPP / NAP 2026 tangible personal property roll (fl_dor_tpp_2026p)",
      lines: [
        `${business.source}. ${count(business.account_count)} tangible-personal-property business accounts, carrying NAICS code, owner name and situs address.`,
        `Construction NAICS accounts: ${count(business.construction_naics_count)}. Roofing contractors (NAICS 238160): ${count(business.roofing_naics_238160_count)}.`,
        business.note ? `Scope note: ${business.note}` : null,
        "This is evidence of business activity at a situs address, taken from the county's own tangible-property roll. It is not a business directory, not a tenant registry and not a corporate-registration source.",
      ],
      aliases: [
        "TPP",
        "NAP",
        "tangible personal property",
        "fl_dor_tpp_2026p",
        "business accounts",
        "NAICS",
      ],
      metadata: { family: "sources", token: "fl_dor_tpp_2026p", status: "ingested" },
      provenance,
    }),
    entityChunk({
      docId: "source:gio",
      docType: "source",
      title:
        "Data source: Florida GIO statewide parcel centroids 2025 (fl_gio_parcel_centroid_2025)",
      lines: [
        `${parcel.canonical_source} is the parcel denominator; geometry comes from the Florida GIO statewide parcel-centroid 2025 FeatureServer, which publishes ${count(parcel.gis_feature_count)} Lake rows.`,
        `That is ${count(parcel.count_difference)} fewer than the assessed roll (${(parcel.count_difference_pct ?? 0).toFixed(2)}%), because the centroid release is one roll year older than the 2026 roll.`,
        parcel.discrepancy_explanation
          ? `Why the gap is acceptable: ${parcel.discrepancy_explanation}`
          : null,
        "Consequence for the query table: latitude and longitude are null for parcels first assessed in 2026. Those rows are published with null coordinates rather than dropped, so a radius search silently excludes them unless requireCoordinates is understood.",
        `Endpoint: ${inventory.parcel_geometry ?? "Florida GIO parcel centroid FeatureServer"}. Offset paging breaks past 20,000 rows, so the fetch uses ids-only plus OBJECTID ranges.`,
      ],
      aliases: [
        "GIO",
        "parcel centroids",
        "fl_gio_parcel_centroid_2025",
        "geometry",
        "coordinates source",
        "latitude longitude source",
      ],
      metadata: { family: "sources", token: "fl_gio_parcel_centroid_2025", status: "ingested" },
      provenance,
    }),
    entityChunk({
      docId: "source:cdplus",
      docType: "source",
      title: "Data source: Lake County CD Plus permit layer (lake_cdplus_permits)",
      lines: [
        `The only permit source in the published dataset. ${count(permits.countywide_layer_record_count)} features, ${count(permits.countywide_distinct_permit_count)} distinct permit numbers, ${count(permits.countywide_distinct_parcel_count)} distinct parcels.`,
        `Roofing permits: ${count(permits.roofing_permit_count)}. Open permits: ${count(permits.open_permit_count)}. Open roofing permits: ${count(permits.open_roofing_permit_count)}.`,
        `Join: the permit layer's Alternate_Key matches the NAL ALT_KEY column; the undashed PARCEL_ID matches the layer's Parcel_ID. Alternate_Key is the better join because it is populated on 100% of permit features.`,
        permits.coverage_finding ? `Two measured limits: ${permits.coverage_finding}` : null,
        "Contractor of record is NOT exposed by this layer. For unincorporated Lake County it lives on the county permit detail pages, which sit behind a Cloudflare managed challenge, so contractor_name is published null on every parcel this layer is the only permit source for. Clermont's own portal is the exception and is harvested separately.",
        `Endpoint: ${inventory.permits_unincorporated ?? "Esri MapServer proxy on utility.arcgis.com"}. IN lists longer than about 50 values return HTTP 500, so paging is done by OBJECTID range.`,
      ],
      aliases: [
        "CD Plus",
        "CDPlus",
        "permit layer",
        "lake_cdplus_permits",
        "Perconti",
        "permit source",
      ],
      metadata: { family: "sources", token: "lake_cdplus_permits", status: "ingested" },
      provenance,
    }),
    entityChunk({
      docId: "source:bbb",
      docType: "source",
      title: "Data source: Better Business Bureau (bbb.org) — GATED, not ingested",
      lines: [
        `BBB enrichment status: ${sources.enrichment?.bbb?.status ?? "gated"}.`,
        sources.enrichment?.bbb?.blocker ? `Blocker: ${sources.enrichment.bbb.blocker}` : null,
        "Consequence: bbb_rating and has_bbb_contractor are real published columns that stay null / false for every row. They are not missing by accident and they must never be read as 'this contractor has no rating'.",
        `Endpoint that refuses this egress: ${inventory.bbb ?? "https://www.bbb.org"}.`,
      ],
      aliases: ["BBB", "better business bureau", "bbb rating", "contractor reputation", "bbb.org"],
      metadata: { family: "sources", token: "bbb", status: "gated" },
      provenance,
    }),
    entityChunk({
      docId: "source:contractor-identity",
      docType: "source",
      title: "Data source: contractor of record — PARTIAL, Clermont only (1 of 15 jurisdictions)",
      lines: [
        `Contractor identity status: ${sources.enrichment?.contractor_identity?.status ?? "gated"}.`,
        sources.enrichment?.contractor_identity?.blocker
          ? `Blocker: ${sources.enrichment.contractor_identity.blocker}`
          : null,
        "Consequence: contractor_name is a real published column that is populated for parcels in Clermont and null on the rest of the county. Clermont is one of fifteen permitting jurisdictions in Lake County, so a contractor count is never countywide coverage and must never be reported as one.",
        "Clermont's eTRAKiT portal is the one open route to contractor names anywhere in the county: its permit detail pages render the contact grid server-side to plain HTTP, and they are harvested. Every other jurisdiction is blocked, unavailable or manual-only.",
        "Outside Clermont a null carries enrichment_status contractor_gated_403 and means 'no source covering this parcel publishes a contractor', not 'no contractor worked on this property'. On a Clermont parcel whose permits named nobody the token is contractor_absent_on_permit, which is an established absence - the source does carry contractors and named none.",
        "For unincorporated Lake County, the route to contractor names is a Chapter 119 records request to the Lake County Office of Building Services for the complete CD Plus permit history including contractor of record.",
      ],
      aliases: [
        "contractor of record",
        "contractor name",
        "who was the contractor",
        "contractor identity",
      ],
      // The YAML says supported_partial; "gated" here would contradict the
      // catalogue this document is built from and would be the wrong answer to
      // "is contractor data available in Lake County".
      metadata: { family: "sources", token: "contractor_identity", status: "partial" },
      provenance,
    }),
    entityChunk({
      docId: "source:sunbiz",
      docType: "source",
      title: "Data source: Florida Sunbiz corporate registration — NOT ingested for this run",
      lines: [
        "Sunbiz corporate registration is a Florida statewide bulk source. It was deliberately not ingested for this run: it is not in this assignment's acceptance criteria, and Sunbiz search is gated from this egress.",
        "Consequence: has_sunbiz_tenant is a real published column that is false for every row. False there means 'not ingested', not 'no company is registered at this address'.",
        "Business activity at an address is instead evidenced by business_account_count, from the DOR tangible-personal-property roll.",
      ],
      aliases: ["Sunbiz", "corporate registration", "has_sunbiz_tenant", "company registry"],
      metadata: { family: "sources", token: "sunbiz", status: "not-ingested" },
      provenance,
    }),
    entityChunk({
      docId: "source:appraiser",
      docType: "source",
      title:
        "Data source: Lake County Property Appraiser (lakecopropappr.com) — reachable but deliberately not used",
      lines: [
        `Base URL ${inventory.property_appraiser ?? "https://lakecopropappr.com"}.`,
        sources.access_states?.correction_to_prior_findings
          ? `Correction to prior findings: ${sources.access_states.correction_to_prior_findings}`
          : null,
        "It was still not used as a source. The DOR roll carries the same assessed facts for all 215,806 parcels in one download, and per-parcel scraping of a county this size buys nothing the roll lacks.",
        "Because no browser flow was built, the appraisal-scraping stages of the kit were deliberately skipped and that substitution is recorded in the deviations document.",
      ],
      aliases: ["property appraiser", "lakecopropappr", "appraiser site", "appraiser portal"],
      metadata: { family: "sources", token: "appraiser", status: "not-used" },
      provenance,
    }),
  ];
}

/** Access states: which hosts refuse this egress, and what that costs. */
export function buildAccessDocs(sources: SourcesYaml, provenance: Provenance): CorpusChunk[] {
  const access = sources.access_states;
  const chunks: CorpusChunk[] = [];
  if (access?.cloudflare_challenged) {
    chunks.push(
      entityChunk({
        docId: "access:cloudflare",
        docType: "access",
        title:
          "Access state: the lakecountyfl.gov estate answers HTTP 403 behind a Cloudflare managed challenge",
        lines: [
          `Challenged hosts: ${access.cloudflare_challenged.hosts.join(", ")}.`,
          access.cloudflare_challenged.evidence
            ? `Evidence: ${access.cloudflare_challenged.evidence}.`
            : null,
          access.cloudflare_challenged.consequence
            ? `Consequence: ${access.cloudflare_challenged.consequence}.`
            : null,
          "The CD Plus permit data is still readable because the Esri MapServer proxy is vendor-hosted on utility.arcgis.com and does not sit behind that estate. It is the permit detail pages, not the permit records, that are blocked.",
          "This single access state is what removes contractor of record from the published dataset.",
        ],
        aliases: ["cloudflare", "403", "lakecountyfl.gov", "managed challenge", "blocked host"],
        metadata: { family: "access", severity: "gated" },
        provenance,
      }),
    );
  }
  return chunks;
}
