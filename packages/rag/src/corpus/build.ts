/**
 * Corpus construction: read the repository's prose and the published run's
 * structured artifacts, and emit one deterministic list of chunks and links.
 *
 * Nothing here reaches the network and nothing here needs a credential. The
 * corpus is a pure function of files already in the checkout, which is what
 * makes the committed index reproducible and the build safe to run in CI.
 */

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load as parseYaml } from "js-yaml";
import { chunkMarkdown } from "./markdown.js";
import {
  buildCoverageDocs,
  buildPublicationDocs,
  buildSampleDocs,
  coverageSchema,
  indexSchema,
  latestSchema,
  manifestSchema,
  type Coverage,
  type Latest,
  type Manifest,
  type PublishedIndex,
  type SampleExtract,
} from "./artifacts.js";
import { buildColumnDocs } from "./columns.js";
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

const RUNTIME_DOCS = resolve(REPO_ROOT, ".claude/skills/use-oracle/runtime/docs");
const PUBLISH_DIR = resolve(
  REPO_ROOT,
  ".claude/skills/use-oracle/runtime/data/artifacts/publish/lake",
);

/** Newest published run directory, or null when nothing has been published. */
export async function resolveRunDir(): Promise<string | null> {
  const runsRoot = resolve(PUBLISH_DIR, "runs");
  if (!existsSync(runsRoot)) return null;
  const entries = await readdir(runsRoot, { withFileTypes: true });
  const runs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const newest = runs.at(-1);
  return newest ? resolve(runsRoot, newest) : null;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
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
    path: ".claude/skills/use-oracle/runtime/docs/lake-county-findings.md",
    aliases: ["county profile", "findings", "discovery", "county discovery"],
  },
  {
    docId: "doc:deviations",
    title: "Kit deviations — where Lake County departs from the team kit and why",
    path: ".claude/skills/use-oracle/runtime/docs/lake-kit-deviations.md",
    aliases: ["deviations", "kit deviations", "why not restate", "kit usage"],
  },
]);

export interface BuiltCorpus {
  chunks: CorpusChunk[];
  links: CorpusLink[];
  runId: string | null;
  rootCid: string | null;
}

/** Read every input and produce the full corpus. */
export async function buildCorpus(): Promise<BuiltCorpus> {
  const runDir = await resolveRunDir();
  const latest = latestSchema
    .nullable()
    .parse(await readJson<Latest>(resolve(REPO_ROOT, "artifacts/latest.json")));
  const runId = latest?.runId ?? (runDir ? (runDir.split("/").at(-1) ?? null) : null);
  const manifest = runId
    ? manifestSchema
        .nullable()
        .parse(await readJson<Manifest>(resolve(REPO_ROOT, `artifacts/manifest-${runId}.json`)))
    : null;
  const rootCid = latest?.rootCid ?? manifest?.root.cid ?? null;

  const cidByArtifact = new Map<string, string>();
  for (const artifact of manifest?.artifacts ?? []) cidByArtifact.set(artifact.name, artifact.cid);

  /** Provenance for a file that lives only in the repository. */
  const repoProvenance = (path: string): Provenance => ({
    sourceFile: path,
    artifact: null,
    runId: null,
    cid: null,
    rootCid: null,
    ipfsPath: null,
  });

  /** Provenance for a file that is also published under the run root. */
  const artifactProvenance = (artifactName: string): Provenance => ({
    sourceFile: runDir ? relative(resolve(runDir, artifactName)) : artifactName,
    artifact: artifactName,
    runId,
    cid: cidByArtifact.get(artifactName) ?? null,
    rootCid,
    ipfsPath: rootCid ? `ipfs://${rootCid}/${artifactName}` : null,
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
    chunks.push(
      ...buildPublicationDocs({
        index: runDir
          ? indexSchema
              .nullable()
              .parse(await readJson<PublishedIndex>(resolve(runDir, "index.json")))
          : null,
        latest,
        manifest,
        ipnsName: catalog.publication?.ipns_name ?? latest?.ipnsName ?? null,
        provenance: artifactProvenance("index.json"),
      }),
    );
  }

  // (d) One document per published column.
  chunks.push(...buildColumnDocs(artifactProvenance("schema.json")));

  // (e) The coverage snapshot, with one document per limitation.
  if (runDir) {
    const coverage = coverageSchema
      .nullable()
      .parse(await readJson<Coverage>(resolve(runDir, "coverage.json")));
    if (coverage) {
      chunks.push(...buildCoverageDocs(coverage, artifactProvenance("coverage.json")));
      for (let position = 1; position <= coverage.limitations.length; position += 1) {
        links.push({
          sourceDocId: `limitation:${position}`,
          targetDocId: "coverage:tables",
          relation: "limits",
        });
      }
    }

    // (f) The published sample extracts.
    const samplesDir = resolve(runDir, "samples");
    if (existsSync(samplesDir)) {
      const names = (await readdir(samplesDir)).filter((name) => name.endsWith(".json")).sort();
      const samples: SampleExtract[] = [];
      for (const name of names) {
        const parsed = await readJson<{
          query?: string;
          rowCount?: number;
          rows?: Record<string, unknown>[];
        }>(resolve(samplesDir, name));
        if (!parsed || typeof parsed.query !== "string") continue;
        samples.push({
          name: name.replace(/\.json$/, ""),
          query: parsed.query.replace(/'[^']*query-table\.parquet'/g, "'query-table.parquet'"),
          rowCount: parsed.rowCount ?? parsed.rows?.length ?? 0,
          columns: Object.keys(parsed.rows?.[0] ?? {}),
        });
      }
      chunks.push(...buildSampleDocs(samples, artifactProvenance));
    }
  }

  // Provenance links from every column document to the source that fills it.
  const SOURCE_DOC_BY_LABEL: Readonly<Record<string, string>> = {
    "FL DOR NAL 2026P": "source:nal",
    "FL GIO parcel centroids 2025": "source:gio",
    "Lake County CD Plus permit layer": "source:cdplus",
    "FL DOR SDF 2026P": "source:sdf",
    "FL DOR TPP 2026P": "source:tpp",
    "gated at source (HTTP 403)": "source:contractor-identity",
  };
  for (const chunk of chunks) {
    if (chunk.docType !== "column") continue;
    const target = SOURCE_DOC_BY_LABEL[chunk.metadata.sourceSystem ?? ""];
    if (target)
      links.push({ sourceDocId: chunk.docId, targetDocId: target, relation: "derived_from" });
  }

  chunks.sort((left, right) => left.id.localeCompare(right.id));
  links.sort((left, right) =>
    `${left.sourceDocId}|${left.targetDocId}|${left.relation}`.localeCompare(
      `${right.sourceDocId}|${right.targetDocId}|${right.relation}`,
    ),
  );

  return { chunks, links, runId, rootCid };
}
