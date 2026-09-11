/**
 * Corpus construction: read the repository's prose and the published run's
 * structured artifacts, and emit one deterministic list of chunks and links.
 *
 * Nothing here reaches the network and nothing here needs a credential. The
 * corpus is a pure function of files already in the checkout, which is what
 * makes the committed index reproducible and the build safe to run in CI.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load as parseYaml } from "js-yaml";
import { z } from "zod";
import {
  PERMIT_TABLE_COLUMN_NAMES,
  QUERY_TABLE_COLUMN_NAMES,
  assertPermitSchemaMatches,
  assertSchemaMatches,
} from "@oracle-lake/shared";
import { chunkMarkdown } from "./markdown.js";
import {
  buildCoverageDocs,
  buildPublicationDocs,
  buildSampleDocs,
  coverageSchema,
  indexSchema,
  type Coverage,
  type PublishedIndex,
  type SampleExtract,
} from "./artifacts.js";
import { buildColumnDocs } from "./columns.js";
import { buildPermitDocs } from "./permits.js";
import { buildSourceSnapshot, selectCorpusSource, type SourceInput } from "./source.js";
import {
  buildAccessDocs,
  buildJurisdictionDocs,
  buildSourceDocs,
  sourcesYamlSchema,
} from "./sources-yaml.js";
import type { CorpusChunk, CorpusLink, DocType, Provenance } from "../types.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Repository root, resolved from either `src/corpus` or `dist/corpus`. */
export const REPO_ROOT = process.env.ORACLE_REPO_ROOT ?? resolve(here, "../../../..");

const RUNTIME_DOCS = resolve(REPO_ROOT, "pipeline/docs");
async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

/** Repository-relative path, so provenance is portable between checkouts. */
function relative(path: string): string {
  return path.startsWith(REPO_ROOT) ? path.slice(REPO_ROOT.length + 1) : path;
}

interface MarkdownSource {
  docId: string;
  title: string;
  path: string;
  aliases: string[];
}

const MARKDOWN_SOURCES: readonly MarkdownSource[] = Object.freeze([
  {
    docId: "doc:readme",
    title: "Project README — Oracle Property Intelligence Pipeline, Lake County FL",
    path: "README.md",
    aliases: ["readme", "project overview", "what is this project"],
  },
  {
    docId: "doc:runbook",
    title: "Runbook — how to run the Lake County pipeline",
    path: "docs/runbook.md",
    aliases: ["runbook", "how do i run it", "pipeline commands", "operations"],
  },
  {
    docId: "doc:quality-audit",
    title: "Repository quality audit — repaired state and external blockers",
    path: "docs/quality-audit.md",
    aliases: ["quality audit", "repair status", "external blockers", "salvage verdict"],
  },
  {
    docId: "doc:observability",
    title: "Observability and on-call handoff",
    path: "docs/observability-handoff.md",
    aliases: ["observability", "metrics", "pagerduty", "dashboard", "alerts", "log retention"],
  },
  {
    docId: "doc:cost",
    title: "Cost model — why Oracle carries no ongoing infrastructure cost",
    path: "docs/cost.md",
    aliases: ["cost model", "ongoing cost", "infrastructure cost", "how much does it cost"],
  },
  {
    docId: "doc:demo",
    title: "Demo script — Lake County walkthrough",
    path: "docs/demo-script.md",
    aliases: ["demo script", "walkthrough", "demo"],
  },
  {
    docId: "doc:findings",
    title: "County profile — Lake County, FL discovery findings",
    path: "pipeline/docs/lake-county-findings.md",
    aliases: ["county profile", "findings", "discovery", "county discovery"],
  },
  {
    docId: "doc:deviations",
    title: "Kit deviations — where Lake County departs from the team kit and why",
    path: "pipeline/docs/lake-kit-deviations.md",
    aliases: ["deviations", "kit deviations", "why not restate", "kit usage"],
  },
]);

export interface BuiltCorpus {
  chunks: CorpusChunk[];
  links: CorpusLink[];
  runId: string;
  releaseState: "local_candidate" | "published";
  rootCid: string | null;
  sourceReceipt: string;
  sourceSnapshot: { digest: string; inputs: SourceInput[] };
}

/** Read every input and produce the full corpus. */
export async function buildCorpus(expectedRunId?: string): Promise<BuiltCorpus> {
  const selected = await selectCorpusSource(expectedRunId);
  const { runId, releaseState, rootCid, releaseReceipt } = selected.receipt;
  const runDir = selected.runDir;

  const artifactPath = (name: string): string => {
    const path = selected.artifactPaths.get(name);
    if (!path) throw new Error(`Selected corpus has no ${name}`);
    return path;
  };

  /** Provenance for a file that lives only in the repository. */
  const repoProvenance = (path: string): Provenance => ({
    sourceFile: path,
    artifact: null,
    runId: null,
    cid: null,
    rootCid: null,
    ipfsPath: null,
    releaseState: "repository",
  });

  /** Provenance for a file that is also published under the run root. */
  const artifactProvenance = (artifactName: string): Provenance => ({
    sourceFile: runDir ? relative(resolve(runDir, artifactName)) : artifactName,
    artifact: artifactName,
    runId,
    cid: null,
    rootCid,
    ipfsPath: rootCid ? `ipfs://${rootCid}/${artifactName}` : null,
    releaseState,
  });

  const chunks: CorpusChunk[] = [];
  const links: CorpusLink[] = [];

  // (a) Prose from the repository's own documentation.
  for (const source of MARKDOWN_SOURCES) {
    const path = resolve(REPO_ROOT, source.path);
    if (!existsSync(path)) continue;
    const markdown = await readFile(path, "utf8");
    chunks.push(
      ...chunkMarkdown({
        docId: source.docId,
        docType: "doc" satisfies DocType,
        title: source.title,
        markdown,
        provenance: repoProvenance(source.path),
        metadata: { family: "docs", file: source.path },
        aliases: source.aliases,
      }),
    );
  }

  // (b) The source catalog: jurisdictions, sources, access states.
  const catalogPath = resolve(RUNTIME_DOCS, "lake-sources.yaml");
  if (existsSync(catalogPath)) {
    const catalogText = await readFile(catalogPath, "utf8");
    const catalog = sourcesYamlSchema.parse(parseYaml(catalogText));
    const catalogProvenance = repoProvenance(relative(catalogPath));
    const jurisdictions = buildJurisdictionDocs(catalog, catalogProvenance);
    chunks.push(...jurisdictions.chunks);
    links.push(...jurisdictions.links);
    chunks.push(...buildSourceDocs(catalog, catalogProvenance));
    chunks.push(...buildAccessDocs(catalog, catalogProvenance));

    // (c) The published run identity.
    const publishedIndex = indexSchema.parse(
      await readJson<PublishedIndex>(artifactPath("index.json")),
    );
    if (publishedIndex.runId !== runId) {
      throw new Error(`index.json belongs to ${publishedIndex.runId}, expected ${runId}`);
    }
    chunks.push(
      ...buildPublicationDocs({
        index: publishedIndex,
        runId,
        releaseState,
        rootCid,
        releaseReceipt,
        ipnsName: catalog.publication?.ipns_name ?? null,
        provenance: artifactProvenance("index.json"),
      }),
    );
  }

  const tableSchema = z.object({
    columnCount: z.number().int(),
    columns: z.array(z.object({ name: z.string(), type: z.string(), optional: z.boolean() })),
  });
  const querySchema = tableSchema.parse(await readJson(artifactPath("schema.json")));
  const permitSchema = tableSchema.parse(await readJson(artifactPath("permit-schema.json")));
  assertSchemaMatches(querySchema.columns.map((column) => column.name));
  assertPermitSchemaMatches(permitSchema.columns.map((column) => column.name));
  if (querySchema.columnCount !== QUERY_TABLE_COLUMN_NAMES.length) {
    throw new Error(
      `schema.json columnCount is ${querySchema.columnCount}, expected ${QUERY_TABLE_COLUMN_NAMES.length}`,
    );
  }
  if (permitSchema.columnCount !== PERMIT_TABLE_COLUMN_NAMES.length) {
    throw new Error(
      `permit-schema.json columnCount is ${permitSchema.columnCount}, expected ${PERMIT_TABLE_COLUMN_NAMES.length}`,
    );
  }

  const coverage = coverageSchema.parse(await readJson<Coverage>(artifactPath("coverage.json")));
  if (coverage.runId !== runId) {
    throw new Error(`coverage.json belongs to ${coverage.runId}, expected ${runId}`);
  }

  // (d) One document per property column and per permit column.
  chunks.push(...buildColumnDocs(artifactProvenance("schema.json")));
  chunks.push(...buildPermitDocs(coverage, artifactProvenance("permit-schema.json")));

  // (e) The coverage snapshot, with one document per limitation.
  const coverageDocs = buildCoverageDocs(coverage, artifactProvenance("coverage.json"));
  chunks.push(...coverageDocs);
  for (const limitation of coverageDocs.filter((chunk) => chunk.docId.startsWith("limitation:"))) {
    links.push({
      sourceDocId: "coverage:limitations",
      targetDocId: limitation.docId,
      relation: "documents",
      metadata: { basis: "coverage.json", runId },
    });
    links.push({
      sourceDocId: limitation.docId,
      targetDocId: "coverage:tables",
      relation: "limits",
      metadata: { basis: "coverage.json", runId },
    });
  }

  // (f) Exactly the sample extracts named and hashed by the source receipt.
  const sampleNames = selected.receipt.artifacts
    .map((artifact) => artifact.name)
    .filter((name) => name.startsWith("samples/") && name.endsWith(".json"))
    .sort();
  const samples: SampleExtract[] = [];
  for (const artifactName of sampleNames) {
    const parsed = await readJson<{
      query?: string;
      rowCount?: number;
      rows?: Record<string, unknown>[];
    }>(artifactPath(artifactName));
    if (typeof parsed.query !== "string") {
      throw new Error(`${artifactName} has no query string`);
    }
    samples.push({
      name: artifactName.replace(/^samples\//, "").replace(/\.json$/, ""),
      query: parsed.query.replace(/'[^']*query-table\.parquet'/g, "'query-table.parquet'"),
      rowCount: parsed.rowCount ?? parsed.rows?.length ?? 0,
      columns: Object.keys(parsed.rows?.[0] ?? {}),
    });
  }
  chunks.push(...buildSampleDocs(samples, artifactProvenance));

  // Provenance links from every column document to the source that fills it.
  //
  // A label maps to a LIST, not to one document, because a column can draw on
  // more than one source: the permit aggregates are filled by the county CD
  // Plus layer for unincorporated Lake and by Clermont's portal for that
  // municipality, and linking such a column to only one of them would make the
  // other invisible to anything that walks these edges.
  const SOURCE_DOCS_BY_LABEL: Readonly<Record<string, readonly string[]>> = {
    "FL DOR NAL 2026P": ["source:nal"],
    "FL GIO parcel centroids 2025": ["source:gio"],
    "Lake County CD Plus permit layer": ["source:cdplus"],
    "Lake County CD Plus permit layer + Clermont eTRAKiT permits": [
      "source:cdplus",
      "jurisdiction:clermont",
    ],
    "FL DOR SDF 2026P": ["source:sdf"],
    "FL DOR TPP 2026P": ["source:tpp"],
    "gated at source (HTTP 403)": ["source:contractor-identity"],
    // schema.ts's label for contractor_name, which stopped being the gated one
    // when Clermont's portal started supplying the column. It keeps the gated
    // document, because that is where the whole fifteen-jurisdiction picture is
    // written down, and gains the jurisdiction that actually supplies the value.
    "Clermont eTRAKiT permits; null elsewhere": [
      "source:contractor-identity",
      "jurisdiction:clermont",
    ],
  };
  for (const chunk of chunks) {
    if (chunk.docType !== "column") continue;
    for (const target of SOURCE_DOCS_BY_LABEL[chunk.metadata.sourceSystem ?? ""] ?? []) {
      links.push({
        sourceDocId: chunk.docId,
        targetDocId: target,
        relation: "derived_from",
        metadata: { sourceSystem: chunk.metadata.sourceSystem ?? "unknown" },
      });
    }
  }

  links.push({
    sourceDocId: "permit:table",
    targetDocId: "source:cdplus",
    relation: "derived_from",
    metadata: { sourceSystem: "lake_cdplus_permits" },
  });
  links.push({
    sourceDocId: "permit:table",
    targetDocId: "jurisdiction:clermont",
    relation: "derived_from",
    metadata: { sourceSystem: "lake_clermont_etrakit_permits" },
  });
  links.push({
    sourceDocId: "coverage:clermont-contractors",
    targetDocId: "jurisdiction:clermont",
    relation: "derived_from",
    metadata: { basis: "coverage.json", jurisdiction: "Clermont" },
  });
  links.push({
    sourceDocId: "coverage:clermont-contractors",
    targetDocId: "limitation:contractor-coverage",
    relation: "limits",
    metadata: { basis: "coverage.json", jurisdiction: "Clermont" },
  });

  chunks.sort((left, right) => left.id.localeCompare(right.id));
  links.sort((left, right) =>
    `${left.sourceDocId}|${left.targetDocId}|${left.relation}`.localeCompare(
      `${right.sourceDocId}|${right.targetDocId}|${right.relation}`,
    ),
  );

  const sourcePaths = [
    selected.receiptPath,
    ...(selected.releaseReceiptPath ? [selected.releaseReceiptPath] : []),
    ...selected.artifactPaths.values(),
    ...chunks.map((chunk) => resolve(REPO_ROOT, chunk.provenance.sourceFile)),
    resolve(REPO_ROOT, "packages/shared/src/schema.ts"),
    resolve(REPO_ROOT, "packages/shared/src/permits.ts"),
    resolve(REPO_ROOT, "packages/rag/src/aliases.ts"),
    resolve(REPO_ROOT, "packages/rag/src/corpus/artifacts.ts"),
    resolve(REPO_ROOT, "packages/rag/src/corpus/columns.ts"),
    resolve(REPO_ROOT, "packages/rag/src/corpus/entity.ts"),
    resolve(REPO_ROOT, "packages/rag/src/corpus/permits.ts"),
    resolve(REPO_ROOT, "packages/rag/src/corpus/sources-yaml.ts"),
  ];
  const sourceSnapshot = await buildSourceSnapshot(sourcePaths);

  return {
    chunks,
    links,
    runId,
    releaseState,
    rootCid,
    sourceReceipt: relative(selected.receiptPath),
    sourceSnapshot,
  };
}
