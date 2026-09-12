/**
 * One retrievable document per selected query-table column.
 *
 * "Why is this field empty" is the question a SQL tool answers worst: the query
 * returns NULL and stops. Each of these documents states what the column means,
 * which upstream system supplies it, and — the part that matters — exactly what
 * a null in it does and does not mean. The always-null columns get the source's
 * own refusal reason rather than a shrug, and the one column published for part
 * of the county - `contractor_name`, which Clermont's permit portal supplies and
 * the other fourteen jurisdictions do not - gets the boundary stated instead of
 * being filed under either "always null" or "always there".
 *
 * The column list is imported from `@oracle-lake/shared`, which is asserted
 * against the selected Parquet by the server's schema gate, so this corpus
 * cannot describe a column the table does not have.
 */

import {
  ALWAYS_NULL_COLUMNS,
  PARTIALLY_POPULATED_COLUMNS,
  QUERY_TABLE_COLUMNS,
  TENURE_CAVEAT,
} from "@oracle-lake/shared";
import { entityChunk } from "./entity.js";
import type { CorpusChunk, Provenance } from "../types.js";

interface ColumnNote {
  /** What the value represents, beyond its label. */
  means?: string;
  /** What a null in this column means. */
  nullWhen?: string;
}

/**
 * Column semantics that cannot be derived from the schema row alone. Columns
 * absent from this table are plain upstream passthroughs and get the generic
 * sentence built in `buildColumnDocs`.
 */
const NOTES: Readonly<Record<string, ColumnNote>> = Object.freeze({
  property_id: {
    means:
      "The pipeline's own stable row key, one per assessed parcel. It is never null; it is what makes the table one-row-per-property.",
  },
  property_cid: {
    means: "Reserved for a per-property IPFS CID.",
    nullWhen:
      "Null on every row. This run stores a single columnar query table plus sharded property JSON, not one CID per property, so nothing populates it.",
  },
  request_identifier: {
    means:
      "The Lake County parcel id, dashed, 23 characters, format NN-NN-NN-NNNN-AAA-AAAAA, where A denotes an uppercase alphanumeric block/lot character. This is the id to quote when a claim is about specific properties, and the id every citation uses. Block and lot segments are not digits-only: 26,616 of 215,806 parcels (12.3%) carry a letter there, so a digits-only pattern rejects an eighth of the county.",
  },
  parcel_identifier: {
    means: "The same parcel id as request_identifier, carried under the schema's canonical name.",
  },
  alt_key: {
    means:
      "The DOR Alternate Key, 7 digits, unique across all 215,806 rows. This is the join key to the CD Plus permit layer's Alternate_Key field, and it is populated on 100% of permit features, which makes it a better join than the undashed parcel id.",
  },
  source_system: { means: "The pipeline's primary source token for the row." },
  latitude: {
    nullWhen:
      "Null for roughly 4,871 parcels (2.26%). The geometry source is the Florida GIO parcel-centroid 2025 release and the roll is 2026, so parcels first assessed in 2026 have no 2025 centroid yet. Those rows publish with null coordinates rather than being dropped, which means a radius search silently excludes them.",
  },
  longitude: {
    nullWhen:
      "Null for the same roughly 4,871 parcels as latitude: the 2025 centroid release is one roll year older than the 2026 assessment roll.",
  },
  lot_size_acre: {
    means: "Derived from lot_area_sqft by the pipeline, not published by the roll.",
  },
  owner_count: { means: "Derived by the pipeline by counting the owner names in owners_text." },
  owner_out_of_county: {
    means:
      "Derived: true when the owner's mailing address is outside Lake County. It is an absentee-ownership signal, not a residency determination; use coverage.json or SQL for the current count.",
  },
  owner_out_of_state: {
    means:
      "Derived: true when the owner's mailing address is outside Florida; use coverage.json or SQL for the current count.",
  },
  built_year: {
    means:
      "Year built from the DOR roll. Known on 169,007 parcels; it is also the fallback basis for roof age.",
    nullWhen: "Null when the roll publishes no year built, which is the case for most vacant land.",
  },
  effective_built_year: {
    means:
      "The roll's effective year built, which reflects substantial improvement rather than original construction.",
  },
  last_sale_date: {
    means:
      "The most recent sale carried on the current DOR roll. Only 2025-2026 sales are published.",
  },
  prior_sale_date: {
    means:
      "The second-most-recent sale carried on the current DOR roll, within the same 2025-2026 window.",
  },
  sale_records_in_window: {
    means:
      "How many sale records the DOR SDF file publishes for this parcel inside the 2025-2026 window. 37,020 sale records exist across 30,977 parcels.",
  },
  no_recorded_sale_in_dor_window: {
    means: `Derived: true when the parcel has no sale record inside the loaded DOR window. True on 184,829 parcels. ${TENURE_CAVEAT}`,
  },
  roof_age_years: {
    means:
      "Derived roof age in years. Fifteen years is the county's default aged-roof threshold. Always read it together with roof_age_basis, because the two bases mean very different things; use coverage.json or SQL for current counts.",
    nullWhen: "Null when neither a roofing permit nor a year built is available for the parcel.",
  },
  roof_age_basis: {
    means:
      "Derived: names the evidence roof_age_years was computed from. roofing_permit_completed means a completed roofing permit dated the roof (the strongest basis). roofing_permit_issued means a roofing permit was issued but not recorded complete. year_built means no roofing permit is on record and the structure's year built was used, which makes the roof age an UPPER BOUND on roof age rather than a measurement of the roof. Because permit sources have jurisdiction and time limits, a year_built basis can mean 'the re-roof is outside the loaded permit coverage', not 'the roof was never replaced'.",
  },
  roof_last_permit_date: {
    means: "The roofing permit date that dated the roof, when the basis is a permit.",
    nullWhen:
      "Null when roof_age_basis is year_built, because no roofing permit was on record for the parcel.",
  },
  has_permits: {
    means:
      "True when either loaded permit source publishes at least one permit that links to the parcel; use coverage.json or SQL for the current count.",
    nullWhen:
      "False is not proof that no permit exists. The layer carries a rolling 365-day Permit_LastModDate window and covers unincorporated Lake County only, so a permit issued by any of the 14 municipalities, or issued and closed before the window, is simply absent.",
  },
  permit_count: {
    means:
      "Permit rows from the loaded county CD Plus and Clermont eTRAKiT sources joined to this parcel; use permit-table.parquet for record-level detail.",
  },
  roofing_permit_count: {
    means:
      "Loaded permits classified as roofing on this parcel. Use coverage.json or SQL for the current count and permit-table.parquet for the qualifying rows.",
  },
  open_permit_count: {
    means: "Permits in an open status: APPLY, INSPECT, ISSUED, READY or RENEWED.",
  },
  open_roofing_permit_count: {
    means:
      "Open roofing permits on this parcel. Use longest_open_roofing_permit_days for a duration threshold and coverage.json or SQL for current counts.",
  },
  longest_open_permit_days: {
    means:
      "Days the parcel's longest-running open permit of any type has been open. It must not be used as proof that a roofing permit has been open that long.",
  },
  longest_open_roofing_permit_days: {
    means:
      "Days the parcel's longest-running open roofing permit has been open. A five-year roofing lead requires this roofing-specific value to be at least 1,825 days; the generic longest_open_permit_days is not a substitute.",
  },
  latest_permit_date: {
    means:
      "Most recent permit date on the parcel from either loaded permit source: the county CD Plus layer or Clermont eTRAKiT.",
  },
  contractor_name: {
    means:
      "Contractor of record for the parcel's permits, as published by the permitting jurisdiction. Where a parcel has several permits it is the contractor on the most recently dated one, not the only contractor who has ever worked there.",
    nullWhen:
      "Populated for parcels in Clermont and null on the rest of the county. Clermont is one of Lake County's fifteen permitting jurisdictions and the only one whose permit portal publishes a contractor of record: its eTRAKiT detail pages render the contact grid to plain HTTP and are harvested. Never read a contractor count as countywide coverage. Where the column is null, enrichment_status says which null it is. contractor_gated_403 means no source covering that parcel publishes a contractor at all - the CD Plus layer carries no contractor field, every lakecountyfl.gov permit detail page sits behind a Cloudflare managed challenge answering HTTP 403 to every egress tested, and thirteen of the other fourteen municipalities are blocked, unavailable or manual-only - so the null means the source refuses the request and never that no contractor worked on the property. contractor_absent_on_permit means Clermont did publish this parcel's permits and none of them named anybody, an owner-builder permit for example, which is an established absence. Neither null may be inferred from an owner name. For unincorporated Lake County the route to the rest is a Chapter 119 records request to the Lake County Office of Building Services.",
  },
  bbb_rating: {
    means: "Better Business Bureau rating for the contractor.",
    nullWhen:
      "Null on every row. BBB's default request/browser route returned HTTP 403; one prohibited browser-fingerprint spoof returned 200 during verification, but no result was retained and no approved official-API harvest was run.",
  },
  has_bbb_contractor: {
    nullWhen:
      "Null on every row because BBB enrichment is policy/API-gated and was not run. The value is unknown/not established, never false: no inference about contractor BBB presence is permitted.",
  },
  has_sunbiz_tenant: {
    nullWhen:
      "Null on every row because Sunbiz corporate registration was not ingested for this run. The value is unknown/not established, never false: no inference that an address lacks a registered company is permitted.",
  },
  has_business_account: {
    means:
      "True when the DOR tangible-personal-property roll carries a business account at this situs address. True on 2,726 parcels.",
  },
  business_account_count: {
    means:
      "Tangible-personal-property business accounts at this situs address, from the 33,346-account DOR TPP roll. It is evidence of business activity at the address, not a business directory and not a tenant registry.",
  },
  enrichment_status: {
    means:
      "Semicolon-separated tokens recording what happened during enrichment for this row: permits_loaded, no_permits_in_source, contractor_from_clermont_etrakit, contractor_absent_on_permit, contractor_gated_403, bbb_gated_403. This is the column that carries the reason a null column is null, so the UI renders an explanation instead of a blank cell. The three contractor tokens are mutually exclusive and are the only way to tell a contractor that was never obtainable from one the source established was absent.",
  },
  source_systems: {
    means:
      "Pipe-separated tokens naming every upstream system that contributed to this row: fl_dor_nal_2026p, fl_gio_parcel_centroid_2025, lake_cdplus_permits, lake_clermont_etrakit_permits, fl_dor_sdf_2026p, fl_dor_tpp_2026p. This is per-row provenance, so any answer can name its sources from the row itself, and lake_clermont_etrakit_permits is what distinguishes a parcel whose permits could carry a contractor from one whose permits never could.",
  },
});

/** Build one document per selected-run column. */
export function buildColumnDocs(provenance: Provenance): CorpusChunk[] {
  return QUERY_TABLE_COLUMNS.map((column) => {
    const note = NOTES[column.name] ?? {};
    const alwaysNull = ALWAYS_NULL_COLUMNS[column.name];
    // A column published for part of the county belongs in neither of the two
    // sentences below that speak about the whole table. It gets its own, which
    // states the boundary, so a retrieved document can never answer "why is
    // this empty" with "it is empty everywhere" about a column that is not.
    const partial = PARTIALLY_POPULATED_COLUMNS[column.name];
    const nullable = column.optional
      ? (note.nullWhen ??
        alwaysNull ??
        partial ??
        `Null when ${column.source} supplied no value for that parcel. Nothing else in the pipeline fills it in.`)
      : "Never null: it is required on every selected-run row.";

    return entityChunk({
      docId: `column:${column.name}`,
      docType: "column",
      title: `Query-table column ${column.name} — ${column.label}`,
      lines: [
        `Column ${column.name} of the selected Lake County query table. Parquet type ${column.type}. Nullable: ${column.optional ? "yes" : "no"}. Human label: ${column.label}. Supplied by: ${column.source}.`,
        note.means
          ? `What it means: ${note.means}`
          : `What it means: ${column.label}, as supplied by ${column.source}.`,
        `When it is null or empty: ${nullable}`,
        alwaysNull ? `This column is empty on every row of the table. Reason: ${alwaysNull}` : null,
        partial ? `This column is populated for part of the county only: ${partial}` : null,
      ],
      aliases: [column.name, column.name.replace(/_/g, " "), column.label],
      metadata: {
        family: "schema",
        column: column.name,
        parquetType: column.type,
        sourceSystem: column.source,
        alwaysNull: String(alwaysNull !== undefined),
        partiallyPopulated: String(partial !== undefined),
      },
      provenance,
    });
  });
}
