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
import { PERMIT_TABLE_COLUMN_NAMES, QUERY_TABLE_COLUMN_COUNT } from "@oracle-lake/shared";
import { buildCorpus } from "../src/corpus/build.js";
import {
  splitSections,
  windowBody,
  chunkMarkdown,
  MAX_SECTION_CHARS,
} from "../src/corpus/markdown.js";
import type { CorpusChunk } from "../src/types.js";

const corpusPromise = buildCorpus();

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
    const columnDocs = chunks.filter((chunk) => chunk.docType === "column");
    const propertyColumns = columnDocs.filter(
      (chunk) => chunk.metadata.table !== "permit-table.parquet",
    );
    const permitColumns = columnDocs.filter(
      (chunk) => chunk.metadata.table === "permit-table.parquet",
    );
    expect(propertyColumns).toHaveLength(QUERY_TABLE_COLUMN_COUNT);
    expect(new Set(propertyColumns.map((chunk) => chunk.metadata.column)).size).toBe(
      QUERY_TABLE_COLUMN_COUNT,
    );
    expect(permitColumns).toHaveLength(PERMIT_TABLE_COLUMN_NAMES.length);
    expect(new Set(permitColumns.map((chunk) => chunk.metadata.column)).size).toBe(
      PERMIT_TABLE_COLUMN_NAMES.length,
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

  it("does not borrow a public CID for local-candidate artifacts", async () => {
    const { chunks, rootCid, releaseState } = await corpusPromise;
    const artifacts = chunks.filter((chunk) => chunk.provenance.artifact !== null);
    expect(artifacts.length).toBeGreaterThan(0);
    expect(releaseState).toBe("local_candidate");
    expect(rootCid).toBeNull();
    for (const chunk of artifacts) {
      expect(chunk.provenance.rootCid).toBe(rootCid);
      expect(chunk.provenance.ipfsPath).toBeNull();
      expect(chunk.provenance.releaseState).toBe("local_candidate");
    }
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

  it("links every column document to the source that fills it", async () => {
    const { links } = await corpusPromise;
    const derived = links.filter((link) => link.relation === "derived_from");
    expect(derived.length).toBeGreaterThan(40);
    expect(derived.some((link) => link.sourceDocId === "column:roof_last_permit_date")).toBe(true);
  });
});
