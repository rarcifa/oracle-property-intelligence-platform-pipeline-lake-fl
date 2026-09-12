/** Generated documentation for the one-row-per-permit companion table. */

import { PERMIT_TABLE_COLUMNS } from "@oracle-lake/shared";
import { entityChunk, count } from "./entity.js";
import type { Coverage } from "./artifacts.js";
import type { CorpusChunk, Provenance } from "../types.js";

const NOTES: Readonly<Record<string, string>> = Object.freeze({
  permit_id: "Stable row identifier used to distinguish permit records across source systems.",
  permit_number: "Permit number exactly as supplied by the issuing jurisdiction.",
  parcel_identifier:
    "Lake County parcel identifier when the permit links to the current assessed roll; null does not make the permit invalid.",
  alt_key:
    "DOR alternate key used to reconcile the permit to a property when the source supplies it.",
  jurisdiction: "Permit-issuing authority. Lake County permitting is not one countywide system.",
  permit_type: "Source permit type or code; roofing classification is also exposed as is_roofing.",
  permit_description: "Source description of the permitted work.",
  permit_status: "Status exactly as normalized from the issuing source.",
  applied_date: "Application date when the source publishes it.",
  approved_date: "Approval date when the source publishes it.",
  issued_date: "Issue date when the source publishes it.",
  completed_date: "Completion or certificate-of-occupancy date when the source publishes it.",
  last_modified_date: "Last-modified date when the source publishes it.",
  is_roofing:
    "True only when the permit type or normalized description meets the roofing classifier.",
  is_open:
    "True only for the documented open-status set; it is not inferred from a missing completion date.",
  days_open:
    "Elapsed days for an open permit from its best available start date to the run as-of date. Null for permits that are not open or have no usable start date.",
  contractor_name:
    "Contractor of record published by Clermont eTRAKiT. It is null outside the one covered jurisdiction and must never be described as countywide coverage.",
  contractor_license:
    "Contractor licence identifier when Clermont eTRAKiT publishes one; it is not inferred from the contractor name.",
  bbb_rating:
    "Reserved BBB result. It remains null because the source is gated; no rating is inferred from any other field.",
  source_url: "Direct source-record URL retained for audit and human verification.",
  source_system:
    "Stable upstream source token, such as lake_cdplus_permits or lake_clermont_etrakit_permits.",
  linkage_status:
    "Whether the permit linked to the current property roll. valid_unlinked rows stay in the permit table instead of being silently dropped.",
});

function tableValue(table: Record<string, unknown>, key: string): number | null {
  const value = table[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Build one table-grain document and one document per permit column. */
export function buildPermitDocs(coverage: Coverage, provenance: Provenance): CorpusChunk[] {
  const permits = (coverage.tables.permits ?? {}) as Record<string, unknown>;
  const contractors = (coverage.tables.contractors ?? {}) as Record<string, unknown>;
  const rows = tableValue(permits, "rows");
  const linked = tableValue(permits, "linked");
  const validUnlinked = tableValue(permits, "validUnlinked");
  const unmatchedKeys = tableValue(permits, "unmatchedParcelKeys");
  const contractorRows = tableValue(contractors, "rows");
  const distinctContractors = tableValue(contractors, "distinctContractors");
  const contractorProperties = tableValue(contractors, "propertiesCovered");
  const coveredJurisdictions = tableValue(contractors, "jurisdictionsCovered");
  const countyJurisdictions = tableValue(contractors, "jurisdictionsInCounty");
  const permitYears = Array.isArray(contractors.permitYears)
    ? contractors.permitYears.map(String).join(", ")
    : "unknown";

  const chunks: CorpusChunk[] = [
    entityChunk({
      docId: "permit:table",
      docType: "coverage",
      title: "Permit table grain, linkage and source-backed detail fields",
      lines: [
        `permit-table.parquet has one row per permit, not one row per property: ${count(rows)} total permit records in selected run ${coverage.runId}.`,
        `${count(linked)} records link to the current assessed-property roll. ${count(validUnlinked)} valid permit records over ${count(unmatchedKeys)} source parcel keys do not; they remain queryable in the permit table and do not create fake property rows.`,
        "The companion property table keeps one row per parcel and carries aggregates. Use the permit table for permit number, jurisdiction, type, description, status, lifecycle dates, roofing/open flags, days open, contractor identity, source URL, source system and linkage status.",
        "A five-year open-roofing lead requires is_roofing = true, is_open = true and days_open >= 1825 on a permit row. The property shortcut is longest_open_roofing_permit_days >= 1825; longest_open_permit_days is broader and must not be substituted.",
      ],
      aliases: [
        "permit table",
        "permit grain",
        "full permit details",
        "one row per permit",
        "valid unlinked permits",
        "five year roofing leads",
        "roofing permit still open for five years",
        "roofing permit open five years defined and evidenced",
      ],
      metadata: {
        family: "permit-schema",
        table: "permit-table.parquet",
        rows: String(rows ?? "unknown"),
        linked: String(linked ?? "unknown"),
        validUnlinked: String(validUnlinked ?? "unknown"),
      },
      provenance,
    }),
    entityChunk({
      docId: "coverage:clermont-contractors",
      docType: "coverage",
      title: "Measured Clermont contractor coverage and its county boundary",
      lines: [
        `Selected run ${coverage.runId} has ${count(contractorRows)} permit rows naming a contractor, ${count(distinctContractors)} distinct contractor names and ${count(contractorProperties)} covered property rows.`,
        `This evidence covers ${count(coveredJurisdictions)} of ${count(countyJurisdictions)} Lake County permit jurisdictions: Clermont only. The loaded permit-year tokens are ${permitYears}.`,
        "These counts are not countywide contractor coverage. Outside Clermont, a null means the loaded source does not publish contractor identity; it must not be interpreted as proof that no contractor worked on the property.",
        "BBB rating is a separate gated enrichment and remains null; contractor presence does not imply a BBB record or rating.",
      ],
      aliases: [
        "Clermont contractor coverage",
        "contractor rows",
        "distinct contractors",
        "one of fifteen jurisdictions",
      ],
      metadata: {
        family: "contractor-coverage",
        jurisdiction: "Clermont",
        rows: String(contractorRows ?? "unknown"),
        jurisdictionsCovered: String(coveredJurisdictions ?? "unknown"),
      },
      provenance,
    }),
  ];

  for (const column of PERMIT_TABLE_COLUMNS) {
    chunks.push(
      entityChunk({
        docId: `permit-column:${column.name}`,
        docType: "column",
        title: `Permit-table column ${column.name}`,
        lines: [
          `Column ${column.name} of permit-table.parquet. Parquet type ${column.type}. Nullable: ${column.optional ? "yes" : "no"}.`,
          NOTES[column.name] ?? "Value preserved from the normalized permit record.",
        ],
        aliases: [column.name, column.name.replace(/_/g, " "), `permit ${column.name}`],
        metadata: {
          family: "permit-schema",
          table: "permit-table.parquet",
          column: column.name,
          parquetType: column.type,
          nullable: String(column.optional),
        },
        provenance,
      }),
    );
  }

  return chunks;
}
