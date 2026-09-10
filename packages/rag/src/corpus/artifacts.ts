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
import type { CorpusChunk, Provenance } from "../types.js";

export const coverageSchema = z.object({
  county: z.string(),
  countyName: z.string(),
  stateCode: z.string(),
  countyFips: z.string(),
  runId: z.string(),
  exportedAt: z.string(),
  denominator: z.object({ basis: z.string(), source: z.string(), assessedParcelCount: z.number() }),
  tables: z.record(z.object({ rows: z.number(), source: z.string() })),
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

export const manifestSchema = z.object({
  runId: z.string(),
  root: z.object({ cid: z.string() }),
  artifacts: z.array(
    z.object({
      cid: z.string(),
      name: z.string(),
      size: z.number(),
      codec: z.string(),
      sha256: z.string(),
    }),
  ),
});

export const latestSchema = z.object({
  runId: z.string(),
  rootCid: z.string(),
  manifestCid: z.string().nullish(),
  ipnsName: z.string().nullish(),
  verifiedGateways: z.array(z.string()).nullish(),
  propertyCount: z.number().nullish(),
  publishedAt: z.string().nullish(),
});

export type Manifest = z.infer<typeof manifestSchema>;
export type Latest = z.infer<typeof latestSchema>;
export type PublishedIndex = z.infer<typeof indexSchema>;

/** Human labels for the coverage snapshot's signal keys. */
const SIGNAL_LABELS: Readonly<Record<string, string>> = Object.freeze({
  roofAgeKnown: "parcels with a known roof age",
  roofAgeFifteenPlus: "parcels whose roof is 15 years or older",
  propertiesWithPermits: "parcels with at least one permit in the published layer",
  roofingPermitRecords: "roofing permit records joined to a parcel",
  propertiesWithOpenRoofingPermit: "parcels with an open roofing permit",
  permitsOpenOverFiveYears: "permits that have been open more than five years",
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

  coverage.limitations.forEach((limitation, position) => {
    chunks.push(
      entityChunk({
        docId: `limitation:${position + 1}`,
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
  latest: Latest | null;
  manifest: Manifest | null;
  ipnsName: string | null;
  provenance: Provenance;
}): CorpusChunk[] {
  const { index, latest, manifest, ipnsName, provenance } = args;
  const chunks: CorpusChunk[] = [];

  chunks.push(
    entityChunk({
      docId: "publication:run",
      docType: "publication",
      title: "How the Lake County dataset is published: run id, CIDs, IPNS name and gateways",
      lines: [
        latest
          ? `The newest verified run is ${latest.runId}, published ${latest.publishedAt ?? "on the run date"} with root CID ${latest.rootCid}.`
          : "No published-run pointer is present in this checkout.",
        latest?.manifestCid
          ? `Its artifact manifest is CID ${latest.manifestCid}, listing every artifact with its CID, byte size, codec and SHA-256.`
          : null,
        ipnsName
          ? `The dataset sits behind one IPNS name, ${ipnsName}, which is re-pointed at each run. A pointer is not a snapshot: every run's own root CID stays permanently resolvable.`
          : null,
        latest?.verifiedGateways?.length
          ? `Retrieval was verified from independent public gateways: ${latest.verifiedGateways.join(", ")}. The gateways ipfs.io, dweb.link and w3s.link answer HTTP 429 to datacenter and VPN egress and are therefore not used as evidence.`
          : null,
        index
          ? `The run directory holds query-table.parquet (the 59-column, one-row-per-parcel table), coverage.json, schema.json, index.json, three sample extracts, and ${index.shardCount} property shards of ${count(index.shardSize)} properties each covering ${count(index.propertyCount)} properties.`
          : null,
        "There is no server in the read path: DuckDB range-reads the Parquet straight from a gateway by CID, so a consumer needs nothing this project runs.",
      ],
      aliases: ["published run", "root cid", "ipns", "how is it published", "gateways", "manifest"],
      metadata: { family: "publication", runId: latest?.runId ?? index?.runId ?? "" },
      provenance,
    }),
  );

  if (manifest) {
    chunks.push(
      entityChunk({
        docId: "publication:artifacts",
        docType: "publication",
        title: "Published artifacts and their content identifiers for the current run",
        lines: [
          `Run ${manifest.runId} publishes ${manifest.artifacts.length} artifacts under root CID ${manifest.root.cid}.`,
          ...manifest.artifacts
            .filter((artifact) => artifact.codec === "file" && !artifact.name.startsWith("shards/"))
            .map(
              (artifact) =>
                `- ${artifact.name}: CID ${artifact.cid}, ${count(artifact.size)} bytes, ${artifact.sha256}.`,
            ),
          "Property shards shards/shard-0000.json through shard-0021.json carry the same CID-addressed treatment; the manifest lists each one.",
          "Fetching any of these from two independent gateways and comparing the SHA-256 against the manifest is what makes 'immutably published' checkable rather than claimed.",
        ],
        aliases: ["artifact cids", "manifest artifacts", "which cid", "sha256", "artifact list"],
        metadata: { family: "publication", runId: manifest.runId },
        provenance,
      }),
    );
  }

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
