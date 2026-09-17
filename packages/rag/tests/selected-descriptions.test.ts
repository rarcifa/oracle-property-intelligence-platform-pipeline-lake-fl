import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildColumnDocs } from "../src/corpus/columns.js";
import { buildCorpus } from "../src/corpus/build.js";
import { selectCorpusSource, sha256 } from "../src/corpus/source.js";
import { selectedDescription } from "../src/corpus/selected-description.js";
import {
  buildJurisdictionDocs,
  buildSourceDocs,
  sourcesYamlSchema,
} from "../src/corpus/sources-yaml.js";
import type { CorpusChunk, Provenance } from "../src/types.js";

// Clearly synthetic descriptions, not copied/relabelled county data or publication receipts.
const catalog = sourcesYamlSchema.parse({
  county: "synthetic-description-fixture",
  state: "FL",
  slug: "synthetic",
  fips: "00000",
  parcel: { canonical_source: "synthetic backbone", assessed_parcel_count: 2 },
  sales: { source: "synthetic sales" },
  business: { source: "synthetic accounts" },
  permits: {
    expected_jurisdiction_count: 2,
    jurisdictions: [
      {
        jurisdiction: "Unincorporated Lake County",
        key: "unincorporated",
        status: "supported",
        implementation_status: "certified",
        adapter: "cdplus",
      },
      {
        jurisdiction: "Clermont",
        key: "clermont",
        status: "supported",
        implementation_status: "historical_capture_review_held",
        adapter: "etrakit",
      },
    ],
  },
});
const catalogProvenance: Provenance = {
  sourceFile: "synthetic/catalog.yaml",
  artifact: null,
  runId: null,
  cid: null,
  rootCid: null,
  ipfsPath: null,
  releaseState: "repository",
};
const coverageProvenance: Provenance = {
  sourceFile: "synthetic/coverage.json",
  artifact: "coverage.json",
  runId: "synthetic-description-run",
  cid: null,
  rootCid: null,
  ipfsPath: null,
  releaseState: "local_candidate",
};
function fixture(sourceOnly: boolean, knownSources = true) {
  return selectedDescription(
    {
      runId: coverageProvenance.runId,
      sourceObservationsOnly: sourceOnly,
      currentPermitStatusAccepted: !sourceOnly,
      completionAccepted: !sourceOnly,
      legalIdentityVerified: false,
      tables: {
        permits: {
          rows: 3,
          ...(knownSources
            ? { bySource: { lake_cdplus_permits: 1, lake_clermont_etrakit_permits: 2 } }
            : {}),
          clermontCaptureWindow: {
            firstYear: 2015,
            lastYear: 2026,
            allRequiredYearPartitionsCaptured: true,
          },
        },
        ...(knownSources ? { contractors: { rows: 1 } } : {}),
      },
    },
    { provenance: coverageProvenance, sha256: "1".repeat(64) },
  );
}
const doc = (chunks: CorpusChunk[], id: string): CorpusChunk => {
  const found = chunks.find((chunk) => chunk.docId === id);
  if (!found) throw new Error(`Missing fixture description ${id}`);
  return found;
};

describe("selected-snapshot descriptions, distinct from catalog certification", () => {
  it("retains loaded historical source-only rows even while acquisition/acceptance review is held", () => {
    const selected = fixture(true);
    const chunks = buildJurisdictionDocs(catalog, catalogProvenance, selected).chunks;
    const clermont = doc(chunks, "jurisdiction:clermont");
    expect(clermont.metadata).toMatchObject({
      harvested: "true",
      retainedPermitRows: "2",
      implementationStatus: "historical_capture_review_held",
      sourceObservationsOnly: "true",
      currentPermitStatusAccepted: "false",
    });
    expect(clermont.textForContext).toContain(
      "retains 2 Clermont permit rows in permit-table.parquet",
    );
    expect(clermont.textForContext).toContain("2015–2026");
    expect(clermont.textForContext).toContain("not accepted current-open status");
    expect(clermont.textForContext).not.toMatch(
      /NOT been harvested|no adapter was built|none of its permits/,
    );
    expect(clermont.provenance).toEqual(coverageProvenance);
    const overview = doc(chunks, "jurisdiction:overview");
    expect(overview.textForContext).toContain("retained permit rows from 2 jurisdictions");
  });

  it("does not turn certified catalog status into selected loaded evidence when source counts are unknown", () => {
    const selected = fixture(true, false);
    const chunks = buildJurisdictionDocs(catalog, catalogProvenance, selected).chunks;
    const county = doc(chunks, "jurisdiction:unincorporated");
    expect(county.metadata.harvested).toBe("unknown");
    expect(county.metadata.retainedPermitRows).toBe("unknown");
    expect(county.textForContext).toContain("availability is unknown, not zero");
    expect(county.textForContext).toContain("Catalog historical-record flag: unknown");
    expect(county.textForContext).not.toContain("no online history");
    expect(county.textForContext).not.toContain("IS harvested");
    const contractor = doc(
      buildSourceDocs(catalog, catalogProvenance, selected),
      "source:contractor-identity",
    );
    expect(contractor.metadata.status).toBe("unknown");
    expect(contractor.textForContext).toContain(
      "does not establish a count of captured contractor names",
    );
    expect(
      doc(buildColumnDocs(coverageProvenance, selected), "column:contractor_name").metadata
        .partiallyPopulated,
    ).toBe("false");
  });

  it("distinguishes historical accepted-decision semantics from held source-only semantics without inferring today's status", () => {
    const historical = fixture(false);
    const selected = fixture(true);
    const held = doc(
      buildColumnDocs(coverageProvenance, selected),
      "column:open_roofing_permit_count",
    );
    const accepted = doc(
      buildColumnDocs(coverageProvenance, historical),
      "column:open_roofing_permit_count",
    );
    expect(held.textForContext).toContain("not accepted in the selected source-only snapshot");
    expect(held.textForContext).toContain("never zero, false, or proof of absence");
    expect(accepted.textForContext).toContain("Acceptance is separate from acquisition");
    expect(accepted.textForContext).toContain(
      "Historical capture alone does not establish today's status",
    );
    const roof = doc(buildColumnDocs(coverageProvenance, selected), "column:roof_age_basis");
    expect(roof.textForContext).toContain("LOW-confidence roof-age proxy");
    expect(roof.textForContext).not.toContain("roofing_permit_completed means");
  });

  it("never treats missing names or legacy diagnostic tokens as established absence or owner-builder evidence", () => {
    for (const selected of [fixture(false), fixture(true), fixture(true, false)]) {
      const chunks = [
        ...buildColumnDocs(coverageProvenance, selected),
        ...buildSourceDocs(catalog, catalogProvenance, selected),
      ];
      for (const id of [
        "column:contractor_name",
        "column:enrichment_status",
        "source:contractor-identity",
      ]) {
        const text = doc(chunks, id).textForContext;
        expect(text).toMatch(
          /unknown|not established|not confirmed absence|not proof of contractor absence/,
        );
        expect(text).not.toMatch(
          /which is an established absence|source established was absent|owner-builder permit for example/,
        );
      }
    }
  });

  it("rejects inconsistent source counts and wrong coverage identities instead of guessing", () => {
    expect(() =>
      selectedDescription(
        {
          runId: coverageProvenance.runId,
          tables: { permits: { rows: 3, bySource: { lake_clermont_etrakit_permits: 4 } } },
        },
        { provenance: coverageProvenance, sha256: "1".repeat(64) },
      ),
    ).toThrow(/do not conserve/);
    expect(() =>
      selectedDescription(
        { runId: "synthetic-wrong-run", tables: {} },
        { provenance: coverageProvenance, sha256: "1".repeat(64) },
      ),
    ).toThrow(/exact coverage identity/);
    expect(() =>
      selectedDescription(
        {
          runId: coverageProvenance.runId,
          tables: { permits: { rows: 3, bySource: { lake_clermont_etrakit_permits: "3" } } },
        },
        { provenance: coverageProvenance, sha256: "1".repeat(64) },
      ),
    ).toThrow();
  });

  it("does not declare a jurisdiction empty when a conserved inventory includes an unmapped source", () => {
    const selected = selectedDescription(
      {
        runId: coverageProvenance.runId,
        sourceObservationsOnly: true,
        tables: {
          permits: {
            rows: 3,
            bySource: { lake_cdplus_permits: 1, synthetic_unmapped_permit_source: 2 },
          },
        },
      },
      { provenance: coverageProvenance, sha256: "1".repeat(64) },
    );
    const clermont = doc(
      buildJurisdictionDocs(catalog, catalogProvenance, selected).chunks,
      "jurisdiction:clermont",
    );
    expect(clermont.metadata.harvested).toBe("unknown");
    expect(clermont.metadata.retainedPermitRows).toBe("unknown");
    expect(clermont.textForContext).toContain("availability is unknown, not zero");
  });

  it("binds real selected retained source counts/grain and descriptions to digest-validated coverage", async () => {
    const selected = await selectCorpusSource();
    const bytes = await readFile(selected.artifactPaths.get("coverage.json")!);
    const raw: unknown = JSON.parse(bytes.toString("utf8"));
    const corpus = await buildCorpus();
    const measured = doc(corpus.chunks, "coverage:clermont-contractors");
    const context = selectedDescription(raw, {
      provenance: measured.provenance,
      sha256: sha256(bytes),
    });
    const clermont = doc(corpus.chunks, "jurisdiction:clermont");
    const cdplus = doc(corpus.chunks, "source:cdplus");
    expect(clermont.metadata.retainedPermitRows).toBe(
      String(context.permitSources?.lake_clermont_etrakit_permits ?? "unknown"),
    );
    for (const chunk of [clermont, cdplus, doc(corpus.chunks, "source:contractor-identity")]) {
      expect(chunk.provenance).toEqual(measured.provenance);
      expect(chunk.metadata.selectedCoverageSha256).toBe(sha256(bytes));
      expect(chunk.metadata.selectedRunId).toBe(selected.receipt.runId);
      expect(chunk.metadata.selectedRootCid).toBe(selected.receipt.rootCid ?? "unpublished");
      expect(chunk.metadata.catalogSourceFile).toBe("pipeline/docs/lake-sources.yaml");
      expect(chunk.textForContext).toContain("Catalog source: pipeline/docs/lake-sources.yaml");
      expect(chunk.textForContext).toContain(
        "authority for catalogued access states, permit systems and records-request recipients/routes",
      );
    }
    for (const chunk of corpus.chunks.filter((entry) => entry.docType === "jurisdiction"))
      expect(chunk.textForContext).toContain("Catalog source: pipeline/docs/lake-sources.yaml");
    expect(clermont.textForContext).toContain("permit-table.parquet");
    if (context.sourceObservationsOnly) {
      expect(clermont.textForContext).toContain("not accepted current-open status");
      expect(doc(corpus.chunks, "source:contractor-identity").textForContext).toContain(
        "missing captured name remains unknown",
      );
    }
  });
});
