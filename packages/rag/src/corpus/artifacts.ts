/**
 * The published run artifacts turned into retrievable documents.
 *
 * `coverage.json` is the county's fail-closed honesty statement: it carries the
 * denominator, the per-table row counts, the derived signals, and the
 * limitations list. Each limitation becomes its own document, because a
 * limitation is exactly the kind of thing a person asks about one at a time
 * ("how far back do the permits go?") and burying six of them in one chunk
 * makes all six harder to find.
 *
 * Every document here carries the artifact's own CID from the run manifest, so
 * a retrieved claim can be checked against the immutable published bytes.
 */

import { z } from "zod";
import { entityChunk, count } from "./entity.js";
import { shortHash } from "../text.js";
import type { CorpusChunk, Provenance } from "../types.js";

export const coverageSchema = z.object({
  county: z.string(),
  countyName: z.string(),
  stateCode: z.string(),
  countyFips: z.string(),
  runId: z.string(),
  exportedAt: z.string(),
  denominator: z.object({ basis: z.string(), source: z.string(), assessedParcelCount: z.number() }),
  tables: z.record(z.object({ rows: z.number(), source: z.string() }).passthrough()),
  signals: z.record(z.number()),
  limitations: z.array(z.string()),
});

export type Coverage = z.infer<typeof coverageSchema>;

export const indexSchema = z.object({
  runId: z.string(),
  propertyCount: z.number(),
  shardSize: z.number(),
  shardCount: z.number(),
  shards: z.array(z.object({ name: z.string(), properties: z.number() })),
  queryTable: z.string(),
});

export type PublishedIndex = z.infer<typeof indexSchema>;

/** Human labels for the coverage snapshot's signal keys. */
const SIGNAL_LABELS: Readonly<Record<string, string>> = Object.freeze({
  roofAgeKnown: "parcels with a known roof age",
  roofAgeFifteenPlus: "parcels whose roof is 15 years or older",
  propertiesWithPermits: "parcels with at least one permit in the published layer",
  roofingPermitRecords: "roofing permit records joined to a parcel",
  propertiesWithOpenRoofingPermit: "parcels with an open roofing permit",
  permitsOpenOverFiveYears:
    "properties with a roofing permit whose roofing-specific open duration is at least five years",
  outOfStateOwners: "parcels whose owner mails out of state",
  outOfCountyOwners: "parcels whose owner mails out of county",
  noRecordedSaleInDorWindow: "parcels with no recorded sale in the published DOR window",
  distinctOwners: "distinct owner names",
  propertiesWithBusinessAccount: "parcels with a tangible-personal-property business account",
});

/**
 * A limitation's own first clause, used as its title.
 *
 * "Documented limitation 3 of 6" is unsearchable and unreadable. The limitation
 * text already opens with its own subject, so the title is taken from it rather
 * than invented.
 */
function limitationHeadline(limitation: string): string {
  const firstSentence = limitation.split(/(?<=\.)\s/)[0] ?? limitation;
  return firstSentence.length > 130 ? `${firstSentence.slice(0, 127)}...` : firstSentence;
}

/** Content-based limitation key that stays stable when a new limitation is inserted. */
function limitationKey(limitation: string): string {
  const keys: readonly [RegExp, string][] = [
    [/rolling 365-day/i, "permit-window"],
    [/covers unincorporated/i, "municipal-coverage"],
    [/^Contractor of record/i, "contractor-coverage"],
    [/^Clermont's permits/i, "clermont-history"],
    [/^BBB ratings/i, "bbb-gated"],
    [/^Ownership tenure/i, "ownership-tenure"],
    [/^Coordinates come/i, "coordinate-vintage"],
    [/permits reference a parcel key absent/i, "unmatched-permits"],
    [/^Business coverage/i, "business-attribution"],
  ];
  return (
    keys.find(([pattern]) => pattern.test(limitation))?.[1] ?? `other-${shortHash(limitation)}`
  );
}

/** Coverage snapshot: denominator, tables, signals, and one doc per limitation. */
export function buildCoverageDocs(coverage: Coverage, provenance: Provenance): CorpusChunk[] {
  const chunks: CorpusChunk[] = [];

  chunks.push(
    entityChunk({
      docId: "coverage:denominator",
      docType: "coverage",
      title: "Coverage: the parcel denominator and what percentage of the county is covered",
      lines: [
        `The denominator for every coverage claim about Lake County is ${count(coverage.denominator.assessedParcelCount)} assessed parcels, basis "${coverage.denominator.basis}", source ${coverage.denominator.source}.`,
        "Geometry is never used as the parcel denominator and never seeds a parcel: a GIS centroid only decorates a tax-roll row that already exists.",
        `The published run is ${coverage.runId}, exported ${coverage.exportedAt}, for ${coverage.countyName} County, ${coverage.stateCode}, FIPS ${coverage.countyFips}.`,
      ],
      aliases: [
        "denominator",
        "how many parcels",
        "parcel count",
        "county total",
        "coverage denominator",
      ],
      metadata: { family: "coverage", runId: coverage.runId },
      provenance,
    }),
  );

  chunks.push(
    entityChunk({
      docId: "coverage:tables",
      docType: "coverage",
      title: "Coverage: how many rows each loaded table has, and which source each came from",
      lines: [
        "Row counts in the published coverage snapshot, one line per table:",
        ...Object.entries(coverage.tables).map(
          ([table, entry]) => `- ${table}: ${count(entry.rows)} rows, from ${entry.source}.`,
        ),
        "These are the numbers to quote for data-scale questions. They come from the published coverage.json, not from a hand-typed figure.",
      ],
      aliases: ["row counts", "table counts", "how much data", "data scale", "loaded tables"],
      metadata: { family: "coverage", runId: coverage.runId },
      provenance,
    }),
  );

  chunks.push(
    entityChunk({
      docId: "coverage:signals",
      docType: "coverage",
      title: "Coverage: the derived lead signals and their countywide counts",
      lines: [
        "Derived signals published in coverage.json, each a countywide count:",
        ...Object.entries(coverage.signals).map(
          ([key, value]) => `- ${key}: ${count(value)} — ${SIGNAL_LABELS[key] ?? key}.`,
        ),
        "Each of these is reproducible with a single SQL predicate against the query table; the RAG corpus carries the definition, the SQL tools carry the live number.",
      ],
      aliases: [
        "signals",
        "lead signals",
        "aged roofs count",
        "open roofing permits count",
        "out of state owners count",
      ],
      metadata: { family: "coverage", runId: coverage.runId },
      provenance,
    }),
  );

  chunks.push(
    entityChunk({
      docId: "coverage:limitations",
      docType: "limitation",
      title: "Coverage limitations carried with the selected run",
      lines: [
        `Candidate run ${coverage.runId} records ${coverage.limitations.length} source and interpretation limitations in coverage.json.`,
        ...coverage.limitations.map(
          (limitation, position) =>
            `- ${position + 1}. ${limitationHeadline(limitation)} (document limitation:${limitationKey(limitation)}).`,
        ),
        "These limitations travel with the data. They constrain every count and must not be replaced by assumptions from missing values.",
      ],
      aliases: ["source limitations", "coverage limitations", "what is missing", "data caveats"],
      metadata: {
        family: "limitations",
        runId: coverage.runId,
        count: String(coverage.limitations.length),
      },
      provenance,
    }),
  );

  coverage.limitations.forEach((limitation, position) => {
    chunks.push(
      entityChunk({
        docId: `limitation:${limitationKey(limitation)}`,
        docType: "limitation",
        title: `Documented limitation ${position + 1} of ${coverage.limitations.length}: ${limitationHeadline(limitation)}`,
        lines: [
          limitation,
          "This limitation is published inside coverage.json in every run, so it travels with the data rather than living only in a README.",
        ],
        aliases: [],
        metadata: { family: "limitations", runId: coverage.runId, position: String(position + 1) },
        provenance,
      }),
    );
  });

  return chunks;
}

/** The published run: CIDs, IPNS, gateways, shard layout. */
export function buildPublicationDocs(args: {
  index: PublishedIndex | null;
  runId: string;
  releaseState: "local_candidate" | "published";
  rootCid: string | null;
  releaseReceipt: string | null;
  ipnsName: string | null;
  provenance: Provenance;
}): CorpusChunk[] {
  const { index, runId, releaseState, rootCid, releaseReceipt, ipnsName, provenance } = args;
  const chunks: CorpusChunk[] = [];

  chunks.push(
    entityChunk({
      docId: "publication:run",
      docType: "publication",
      title: "How the Lake County dataset is published: run id, CIDs, IPNS name and gateways",
      lines: [
        releaseState === "published"
          ? `The selected corpus run is published: ${runId}, with root CID ${rootCid ?? "missing (invalid receipt)"}.`
          : `The selected corpus run is ${runId}, an unpublished local candidate. It has no public root CID, artifact CIDs or IPFS paths, and this corpus does not borrow them from an older public run.`,
        releaseReceipt
          ? `External release receipt: ${releaseReceipt}. This receipt, not directory recency, binds the immutable public identity.`
          : "No external release receipt exists for this local candidate.",
        releaseState === "published" && ipnsName
          ? `The dataset sits behind one IPNS name, ${ipnsName}, which is re-pointed at each run. A pointer is not a snapshot: every run's own root CID stays permanently resolvable.`
          : null,
        index
          ? `The run directory holds query-table.parquet (the 63-column, one-row-per-parcel table), permit-table.parquet (one row per permit), coverage.json, schema.json, permit-schema.json, index.json, three sample extracts, and ${index.shardCount} property shards of ${count(index.shardSize)} properties each covering ${count(index.propertyCount)} properties.`
          : null,
        releaseState === "published"
          ? "There is no server in the data read path: DuckDB can range-read the Parquet from a gateway by immutable CID."
          : "Local validation reads the candidate artifacts from disk. Public claims remain bound to the older deployed release until this exact candidate is separately approved, published, verified and deployed.",
      ],
      aliases: ["published run", "root cid", "ipns", "how is it published", "gateways", "manifest"],
      metadata: { family: "publication", runId, releaseState },
      provenance,
    }),
  );

  return chunks;
}

export interface SampleExtract {
  name: string;
  query: string;
  rowCount: number;
  columns: string[];
}

/** One document per published sample extract. */
export function buildSampleDocs(
  samples: SampleExtract[],
  provenanceFor: (name: string) => Provenance,
): CorpusChunk[] {
  const descriptions: Readonly<Record<string, string>> = {
    "aged-roofs":
      "the 100 oldest known roofs that also have coordinates, ordered by roof age, for the aged-roof lead view",
    "open-roofing-permits":
      "the 100 parcels with an open roofing permit, longest open first, including the gated contractor and BBB columns so the empty-with-a-reason rendering is demonstrable",
    "out-of-area-owners":
      "100 parcels whose owner mails out of state, for the absentee-owner lead view",
  };

  return samples.map((sample) =>
    entityChunk({
      docId: `sample:${sample.name}`,
      docType: "sample",
      title: `Published sample extract ${sample.name}.json`,
      lines: [
        `A ${count(sample.rowCount)}-row sample extract published in the run directory as samples/${sample.name}.json. It contains ${descriptions[sample.name] ?? "a slice of the query table"}.`,
        `Columns in the extract: ${sample.columns.join(", ")}.`,
        `The exact SQL that produced it: ${sample.query}`,
        "The extract is a demonstration slice, not the dataset. Counts must come from the full query table, never from a sample.",
      ],
      aliases: [
        `${sample.name} sample`,
        `samples/${sample.name}.json`,
        sample.name.replace(/-/g, " "),
      ],
      metadata: { family: "samples", sample: sample.name },
      provenance: provenanceFor(`samples/${sample.name}.json`),
    }),
  );
}
