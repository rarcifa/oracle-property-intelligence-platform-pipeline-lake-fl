/**
 * Corpus construction tests.
 *
 * The property that matters most here is determinism: the retrieval index is a
 * committed build artifact, so a corpus that shuffles between runs would make
 * every rebuild a spurious diff and every stored score meaningless. These tests
 * build the corpus twice in one process and assert the two are identical, then
 * check the structural invariants the retriever and the citations depend on.
 */

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import { PERMIT_TABLE_COLUMN_NAMES, QUERY_TABLE_COLUMN_NAMES } from "@oracle-lake/shared";
import { buildCorpus } from "../src/corpus/build.js";
import { promotionReceiptSchema, REPO_ROOT, selectCorpusSource } from "../src/corpus/source.js";
import {
  splitSections,
  windowBody,
  chunkMarkdown,
  MAX_SECTION_CHARS,
} from "../src/corpus/markdown.js";
import { buildCoverageDocs, coverageSchema } from "../src/corpus/artifacts.js";
import type { CorpusChunk } from "../src/types.js";

const corpusPromise = buildCorpus();
const selectedPromise = selectCorpusSource();
const selectedSchema = z.object({
  columnCount: z.number().int().positive(),
  columns: z.array(z.object({ name: z.string().min(1) })).min(1),
});

describe("markdown chunking", () => {
  it("splits on headings and carries the heading trail", () => {
    const sections = splitSections("# Top\n\nintro prose\n\n## Inner\n\ninner prose\n");
    expect(sections).toHaveLength(2);
    expect(sections[0]?.headingPath).toEqual(["Top"]);
    expect(sections[1]?.headingPath).toEqual(["Top", "Inner"]);
    expect(sections[1]?.body).toBe("inner prose");
  });

  it("does not treat a hash inside a fenced block as a heading", () => {
    const sections = splitSections("## Real\n\n```bash\n# not a heading\necho hi\n```\n");
    expect(sections).toHaveLength(1);
    expect(sections[0]?.headingPath).toEqual(["Real"]);
  });

  it("leaves a short section as one window", () => {
    expect(windowBody("short body")).toEqual(["short body"]);
  });

  it("windows a long section on paragraph boundaries with overlap", () => {
    const paragraph = "x".repeat(700);
    const windows = windowBody([paragraph, paragraph, paragraph].join("\n\n"));
    expect(windows.length).toBeGreaterThan(1);
    for (const window of windows) expect(window.length).toBeLessThanOrEqual(MAX_SECTION_CHARS * 2);
  });

  it("gives every chunk a deterministic id derived from the document id and ordinal", () => {
    const chunks = chunkMarkdown({
      docId: "doc:test",
      docType: "doc",
      title: "Test",
      markdown: "## One\n\n" + "a".repeat(200) + "\n\n## Two\n\n" + "b".repeat(200),
      provenance: {
        sourceFile: "x.md",
        artifact: null,
        runId: null,
        cid: null,
        rootCid: null,
        ipfsPath: null,
        releaseState: "repository",
      },
      metadata: {},
      aliases: [],
    });
    expect(chunks.map((chunk) => chunk.id)).toEqual(["doc:test#0", "doc:test#1"]);
    expect(chunks.every((chunk) => chunk.chunkCount === 2)).toBe(true);
  });
});

describe("corpus construction", () => {
  it("is deterministic: two builds produce identical chunks", async () => {
    const [first, second] = await Promise.all([corpusPromise, buildCorpus()]);
    const shape = (chunks: CorpusChunk[]): string =>
      JSON.stringify(
        chunks.map((chunk) => [chunk.id, chunk.sourceHash, chunk.textForEmbedding.length]),
      );
    expect(shape(second.chunks)).toBe(shape(first.chunks));
    expect(JSON.stringify(second.links)).toBe(JSON.stringify(first.links));
  });

  it("gives every chunk a unique id matching its document id and index", async () => {
    const { chunks } = await corpusPromise;
    const ids = new Set(chunks.map((chunk) => chunk.id));
    expect(ids.size).toBe(chunks.length);
    for (const chunk of chunks) expect(chunk.id).toBe(`${chunk.docId}#${chunk.chunkIndex}`);
  });

  it("describes every property and permit column exactly once", async () => {
    const { chunks } = await corpusPromise;
    const selected = await selectedPromise;
    const propertySchema = selectedSchema.parse(
      JSON.parse(await readFile(selected.artifactPaths.get("schema.json")!, "utf8")),
    );
    const permitSchema = selectedSchema.parse(
      JSON.parse(await readFile(selected.artifactPaths.get("permit-schema.json")!, "utf8")),
    );
    const propertyNames = propertySchema.columns.map((column) => column.name);
    const permitNames = permitSchema.columns.map((column) => column.name);
    expect(propertySchema.columnCount).toBe(propertyNames.length);
    expect(permitSchema.columnCount).toBe(permitNames.length);
    // Additional selected source-evidence columns are allowed, but the shared
    // canonical query contract must still be present in both actual schemas.
    for (const name of QUERY_TABLE_COLUMN_NAMES) expect(propertyNames).toContain(name);
    for (const name of PERMIT_TABLE_COLUMN_NAMES) expect(permitNames).toContain(name);
    const columnDocs = chunks.filter((chunk) => chunk.docType === "column");
    const propertyColumns = columnDocs.filter(
      (chunk) => chunk.metadata.table !== "permit-table.parquet",
    );
    const permitColumns = columnDocs.filter(
      (chunk) => chunk.metadata.table === "permit-table.parquet",
    );
    expect(propertyColumns).toHaveLength(propertySchema.columnCount);
    expect(new Set(propertyColumns.map((chunk) => chunk.metadata.column)).size).toBe(
      propertySchema.columnCount,
    );
    expect(propertyColumns.map((chunk) => chunk.metadata.column).sort()).toEqual(
      [...propertyNames].sort(),
    );
    expect(permitColumns).toHaveLength(permitSchema.columnCount);
    expect(new Set(permitColumns.map((chunk) => chunk.metadata.column)).size).toBe(
      permitSchema.columnCount,
    );
    expect(permitColumns.map((chunk) => chunk.metadata.column).sort()).toEqual(
      [...permitNames].sort(),
    );
  });

  it("describes all fifteen permit jurisdictions plus an overview", async () => {
    const { chunks } = await corpusPromise;
    const jurisdictions = chunks.filter((chunk) => chunk.docType === "jurisdiction");
    expect(jurisdictions).toHaveLength(16);
    // Two are harvested, not one: unincorporated Lake County through the CD
    // Plus layer, and Clermont through its eTRAKiT portal, which is the only
    // jurisdiction of the fifteen that publishes a contractor of record. The
    // other thirteen are blocked, unavailable or manual-only.
    expect(
      jurisdictions
        .filter((chunk) => chunk.metadata.harvested === "true")
        .map((chunk) => chunk.docId)
        .sort(),
    ).toEqual(["jurisdiction:clermont", "jurisdiction:unincorporated"]);

    const overview = jurisdictions.find((chunk) => chunk.docId === "jurisdiction:overview");
    expect(overview?.textForContext).toContain(
      "Unincorporated Lake County (Perconti CD Plus county layer)",
    );
    expect(overview?.textForContext).toContain("Clermont (CentralSquare eTRAKiT portal)");
    expect(overview?.textForContext).not.toContain("through the Perconti CD Plus permit layer");
  });

  it("carries provenance on every chunk", async () => {
    const { chunks } = await corpusPromise;
    for (const chunk of chunks) {
      expect(chunk.provenance.sourceFile.length).toBeGreaterThan(0);
      expect(chunk.provenance.sourceFile.startsWith("/")).toBe(false);
    }
  });

  it("binds artifact provenance to the validated selected release without borrowing a CID", async () => {
    const { chunks, rootCid, releaseState, runId } = await corpusPromise;
    const { receipt } = await selectedPromise;
    const artifacts = chunks.filter((chunk) => chunk.provenance.artifact !== null);
    expect(artifacts.length).toBeGreaterThan(0);
    expect(runId).toBe(receipt.runId);
    expect(releaseState).toBe(receipt.releaseState);
    expect(rootCid).toBe(receipt.rootCid);
    for (const chunk of artifacts) {
      expect(chunk.provenance.runId).toBe(receipt.runId);
      expect(chunk.provenance.rootCid).toBe(rootCid);
      expect(chunk.provenance.releaseState).toBe(receipt.releaseState);
      if (receipt.releaseState === "local_candidate") {
        expect(chunk.provenance.cid).toBeNull();
        expect(chunk.provenance.ipfsPath).toBeNull();
      } else {
        expect(chunk.provenance.ipfsPath).toBe(
          `ipfs://${receipt.rootCid}/${chunk.provenance.artifact}`,
        );
      }
    }
  });

  it("binds measured permit/contractor counts to actual coverage bytes, not schema bytes", async () => {
    const corpus = await corpusPromise;
    const selected = await selectedPromise;
    const path = selected.artifactPaths.get("coverage.json")!;
    const bytes = await readFile(path);
    const digest = createHash("sha256").update(bytes).digest("hex");
    expect(selected.receipt.artifacts.find((entry) => entry.name === "coverage.json")?.sha256).toBe(
      digest,
    );
    let expectedCid: string | null = null;
    if (selected.releaseReceiptPath) {
      const promotion = promotionReceiptSchema.parse(
        JSON.parse(await readFile(selected.releaseReceiptPath, "utf8")),
      );
      const manifestEvidence = promotion.evidence.find((entry) => entry.role === "manifest")!;
      const manifestBytes = await readFile(resolve(REPO_ROOT, manifestEvidence.path));
      expect(createHash("sha256").update(manifestBytes).digest("hex")).toBe(
        manifestEvidence.sha256,
      );
      const manifest = z
        .object({
          artifacts: z.array(z.object({ name: z.string(), cid: z.string(), sha256: z.string() })),
        })
        .parse(JSON.parse(manifestBytes.toString("utf8")));
      const entry = manifest.artifacts.find((artifact) => artifact.name === "coverage.json")!;
      expect(entry.sha256).toBe(`sha256:${digest}`);
      expectedCid = entry.cid;
      expect(
        corpus.sourceSnapshot.inputs.find((input) => input.path === manifestEvidence.path)?.sha256,
      ).toBe(manifestEvidence.sha256);
    }
    for (const docId of ["permit:table", "coverage:clermont-contractors"]) {
      const chunk = corpus.chunks.find((entry) => entry.docId === docId)!;
      expect(chunk.provenance).toEqual({
        sourceFile: selected.receipt.runDirectory + "/coverage.json",
        artifact: "coverage.json",
        runId: selected.receipt.runId,
        cid: expectedCid,
        rootCid: selected.receipt.rootCid,
        ipfsPath:
          selected.receipt.releaseState === "published"
            ? `ipfs://${selected.receipt.rootCid}/coverage.json`
            : null,
        releaseState: selected.receipt.releaseState,
      });
      expect(chunk.metadata.sourceInputSha256).toBe(digest);
      expect(
        corpus.sourceSnapshot.inputs.find((input) => input.path === chunk.provenance.sourceFile)
          ?.sha256,
      ).toBe(digest);
    }
    expect(
      corpus.chunks.find((entry) => entry.docId === "permit-column:contractor_name")?.provenance
        .artifact,
    ).toBe("permit-schema.json");
  });

  it("states the reason a column is empty rather than leaving it bare", async () => {
    const { chunks } = await corpusPromise;
    const bbb = chunks.find((chunk) => chunk.docId === "column:bbb_rating");
    expect(bbb?.textForContext).toContain("403");
    expect(bbb?.textForContext).toContain("empty on every row of the table");

    // contractor_name is the harder document: it has to give the refusal
    // reason for most of the county AND say which jurisdiction publishes it,
    // or a reader takes "403" for the whole answer and stops.
    const contractor = chunks.find((chunk) => chunk.docId === "column:contractor_name");
    expect(contractor?.textForContext).toContain("403");
    expect(contractor?.textForContext).toContain("never that no contractor worked on the property");
    expect(contractor?.textForContext).toContain("Clermont");
    expect(contractor?.textForContext).toContain("fifteen permitting jurisdictions");
    expect(contractor?.metadata.partiallyPopulated).toBe("true");
    expect(contractor?.metadata.alwaysNull).toBe("false");
    // And it must not be described as empty everywhere.
    expect(contractor?.textForContext).not.toContain("empty on every row of the table");

    for (const docId of ["column:has_bbb_contractor", "column:has_sunbiz_tenant"]) {
      const boolean = chunks.find((chunk) => chunk.docId === docId);
      expect(boolean?.textForContext).toContain("unknown/not established");
      expect(boolean?.textForContext).toContain("never false");
      expect(boolean?.textForContext).not.toMatch(/false on every row/i);
    }

    const parcelId = chunks.find((chunk) => chunk.docId === "column:request_identifier");
    expect(parcelId?.textForContext).toContain("uppercase alphanumeric block/lot");
    expect(parcelId?.textForContext).toContain("not digits-only");
  });

  it("uses selected-run wording and labels superseded immutable evidence as historical", async () => {
    const { chunks } = await corpusPromise;
    const generated = chunks.filter((chunk) => chunk.docType !== "doc");
    const text = generated.map((chunk) => chunk.textForContext).join("\n");
    expect(text).not.toMatch(/published Lake County query table/i);
    expect(text).not.toMatch(/only permit source in the published dataset/i);
    expect(text).not.toMatch(/Candidate run \d/i);
    expect(text).not.toMatch(/published coverage snapshot/i);

    const bbb = chunks.find((chunk) => chunk.docId === "limitation:bbb-gated");
    expect(bbb?.textForContext).toContain("Current verified status");
    expect(bbb?.textForContext).toContain("Historical immutable wording");
    expect(bbb?.textForContext).toContain("must not be used as the current access conclusion");
  });

  it("preserves nullable source-only coverage signals as unknown rather than zero", () => {
    const coverage = coverageSchema.parse({
      county: "lake",
      countyName: "Lake",
      stateCode: "FL",
      countyFips: "12069",
      runId: "20260916T181000Z",
      exportedAt: "2026-09-17T00:00:00.000Z",
      denominator: {
        basis: "assessed parcels",
        source: "synthetic fixture",
        assessedParcelCount: 2,
      },
      tables: {
        properties: { rows: 2, source: "synthetic fixture" },
      },
      signals: {
        roofAgeKnown: 1,
        roofingPermitRecords: null,
        propertiesWithOpenRoofingPermit: null,
        propertiesWithAnyPermitOpenOverFiveYears: null,
      },
      limitations: ["Permit status fields are source-only unknowns in this synthetic fixture."],
    });
    const docs = buildCoverageDocs(coverage, {
      sourceFile: "coverage.json",
      artifact: "coverage.json",
      runId: coverage.runId,
      cid: null,
      rootCid: null,
      ipfsPath: null,
      releaseState: "local_candidate",
    });
    const signals = docs.find((chunk) => chunk.docId === "coverage:signals");

    expect(signals?.textForContext).toContain("roofAgeKnown: 1");
    expect(signals?.textForContext).toContain("roofingPermitRecords: unknown/source-only");
    expect(signals?.textForContext).toContain(
      "propertiesWithOpenRoofingPermit: unknown/source-only",
    );
    expect(signals?.textForContext).toContain(
      "propertiesWithAnyPermitOpenOverFiveYears: unknown/source-only",
    );
    expect(signals?.textForContext).toContain("must not be read as zero");
    expect(signals?.textForContext).not.toContain("roofingPermitRecords: 0");
  });

  it("links every column document to the source that fills it", async () => {
    const { links } = await corpusPromise;
    const derived = links.filter((link) => link.relation === "derived_from");
    expect(derived.length).toBeGreaterThan(40);
    expect(derived.some((link) => link.sourceDocId === "column:roof_last_permit_date")).toBe(true);
  });
});
