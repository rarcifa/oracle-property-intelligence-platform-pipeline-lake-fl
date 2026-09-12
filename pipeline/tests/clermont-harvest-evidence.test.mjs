import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  atomicWriteArtifact,
  buildClermontPermanentDeadEvidence,
  ensureClermontLicenseDirectoryPin,
  harvestPermits,
  inspectClermontHarvestArtifactState,
  summarizeCoverage,
  writeClermontPermitArtifactPair,
} from "../scripts/lake/clermont-permits.mjs";
import {
  normalizeClermontPermit,
  parsePermitDetailHtml,
  parsePermitSearchResults,
} from "../src/counties/lake/clermont-permits.mjs";

function fixture(name) {
  return readFile(
    fileURLToPath(new URL(`./fixtures/lake-clermont/${name}`, import.meta.url)),
    "utf8",
  );
}

async function normalizedFixture({ html, permitNumber, row, alternateKey, parcelId = null }) {
  const detail = parsePermitDetailHtml(html, { expectedPermitNumber: permitNumber });
  return normalizeClermontPermit({
    detail,
    row,
    requestedAlternateKey: alternateKey,
    requestedParcelId: parcelId,
  });
}

function terminal404(row, responseBody = "<html>not found</html>") {
  const observedAt = "2026-09-11T12:00:00.000Z";
  const responseSha256 = createHash("sha256").update(responseBody).digest("hex");
  return {
    classification: "permanent",
    code: "source_record_not_found",
    message: "source returned 404",
    attemptEvidence: [
      {
        attempt: 1,
        maxAttempts: 4,
        observedAt,
        requestUrl: `https://etrakit.clermontfl.org/eTRAKiT3/Search/permit.aspx?activityNo=${row.permitNumber}`,
        requestMethod: "GET",
        httpStatus: 404,
        responseSha256,
        classification: "permanent",
        errorCode: "source_record_not_found",
      },
    ],
    sourceProof: {
      requestUrl: `https://etrakit.clermontfl.org/eTRAKiT3/Search/permit.aspx?activityNo=${row.permitNumber}`,
      requestMethod: "GET",
      httpStatus: 404,
      responseSha256,
      responseBody,
      observedAt,
    },
  };
}

describe("Clermont terminal evidence", () => {
  it("admits only whitelisted source-terminal codes with body and attempt proof", () => {
    const row = { permitNumber: "26-9999", alternateKey: "3925114" };
    const evidence = buildClermontPermanentDeadEvidence({
      row,
      error: terminal404(row),
      observedAt: "2026-09-11T12:00:00.000Z",
    });
    expect(evidence).toMatchObject({
      schemaVersion: "elephant.clermont-permanent-dead-evidence.v2",
      errorCode: "source_record_not_found",
      sourceProof: { httpStatus: 404 },
    });

    const afterTransient = terminal404(row);
    afterTransient.attemptEvidence = [
      {
        attempt: 1,
        maxAttempts: 4,
        observedAt: "2026-09-11T11:59:59.000Z",
        requestUrl: afterTransient.sourceProof.requestUrl,
        requestMethod: "GET",
        httpStatus: 503,
        responseSha256: createHash("sha256").update("unavailable").digest("hex"),
        classification: "transient",
        errorCode: "retryable_http_status",
      },
      { ...afterTransient.attemptEvidence[0], attempt: 2 },
    ];
    expect(
      buildClermontPermanentDeadEvidence({
        row,
        error: afterTransient,
        observedAt: "2026-09-11T12:00:00.000Z",
      }),
    ).not.toBeNull();

    expect(
      buildClermontPermanentDeadEvidence({
        row,
        error: { ...terminal404(row), code: "etrakit_detail_permit_mismatch" },
        observedAt: "2026-09-11T12:00:00.000Z",
      }),
    ).toBeNull();
    expect(
      buildClermontPermanentDeadEvidence({
        row,
        error: { classification: "permanent", code: "source_record_not_found" },
        observedAt: "2026-09-11T12:00:00.000Z",
      }),
    ).toBeNull();
  });

  it("redrives an interrupted raw/extracted commit instead of skipping by filename", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "clermont-partial-"));
    await Promise.all(
      ["raw", "extracted", "dead"].map((directory) =>
        mkdir(path.join(root, directory), { recursive: true }),
      ),
    );
    const html = await fixture("permit-detail-roofing.html");
    const row = { permitNumber: "24-0009", alternateKey: "3597940" };
    const record = await normalizedFixture({
      html,
      permitNumber: row.permitNumber,
      row,
      alternateKey: row.alternateKey,
    });
    const rawPath = path.join(root, "raw", "24-0009.html");
    const extractedPath = path.join(root, "extracted", "24-0009.json");

    await expect(
      writeClermontPermitArtifactPair({
        rawPath,
        extractedPath,
        rawBody: html,
        extractedBody: `${JSON.stringify(record)}\n`,
        afterRawCommit: async () => {
          throw new Error("simulated interruption");
        },
      }),
    ).rejects.toThrow(/simulated interruption/);
    await expect(inspectClermontHarvestArtifactState({ root, row })).resolves.toEqual({
      disposition: "pending",
      reason: "partial_captured_pair",
    });
    expect((await readdir(path.join(root, "raw"))).some((name) => name.endsWith(".tmp"))).toBe(
      false,
    );

    await writeClermontPermitArtifactPair({
      rawPath,
      extractedPath,
      rawBody: html,
      extractedBody: `${JSON.stringify(record)}\n`,
    });
    await expect(inspectClermontHarvestArtifactState({ root, row })).resolves.toEqual({
      disposition: "completed",
      reason: null,
    });
  });

  it("requires typed dead proof rather than accepting a dead filename", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "clermont-dead-"));
    await mkdir(path.join(root, "dead"), { recursive: true });
    const row = { permitNumber: "26-9999", alternateKey: "3925114" };
    await atomicWriteArtifact(path.join(root, "dead", "26-9999.json"), "{}\n");
    await expect(inspectClermontHarvestArtifactState({ root, row })).resolves.toEqual({
      disposition: "pending",
      reason: "dead_evidence_invalid",
    });

    const evidence = buildClermontPermanentDeadEvidence({
      row,
      error: terminal404(row),
      observedAt: "2026-09-11T12:00:00.000Z",
    });
    await atomicWriteArtifact(
      path.join(root, "dead", "26-9999.json"),
      `${JSON.stringify(evidence)}\n`,
    );
    await expect(inspectClermontHarvestArtifactState({ root, row })).resolves.toEqual({
      disposition: "proven-dead",
      reason: null,
    });
  });
});

describe("Clermont immutable license-directory pin", () => {
  const directoryA =
    '<html><select name="ddlSelContractor"><option value="POOL-A">BOWLES CUSTOM POOLS &amp; SPAS INC</option><option value="ROOF-A">WEST ORANGE ROOFING (CCC)</option></select></html>\n';
  const directoryB =
    '<html><select name="ddlSelContractor"><option value="POOL-B">BOWLES CUSTOM POOLS &amp; SPAS INC</option><option value="ROOF-B">WEST ORANGE ROOFING (CCC)</option></select></html>\n';

  it("pins D1 before records and resumes pending work without requesting D2", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "clermont-license-job-"));
    await mkdir(path.join(root, "permit-lists"), { recursive: true });
    const poolHtml = await fixture("permit-detail-with-contractor.html");
    const roofHtml = await fixture("permit-detail-roofing.html");
    const poolRow = parsePermitSearchResults(
      await fixture("permit-search-results-parcel.html"),
    ).rows.at(-1);
    const roofRow = { permitNumber: "24-0009", alternateKey: "3597940" };
    const jobId = "clermont-license-pin-test";
    await writeFile(
      path.join(root, "permit-lists", "clermont-permit-index.json"),
      `${JSON.stringify({ permits: [poolRow, roofRow] })}\n`,
    );
    const seedPath = path.join(root, "seed.csv");
    await writeFile(
      seedPath,
      "parcel_id,alt_key,city,address\n01-22-24-3900-027-00001,3925114,CLERMONT,2171 TIMBER CREEK LN\n",
    );

    let directoryRequests = 0;
    const firstDetailRequests = [];
    const transient = Object.assign(new Error("retry later"), {
      classification: "transient",
      code: "request_timeout",
      attemptEvidence: [],
    });
    await harvestPermits({
      jobId,
      artifactRoot: root,
      seedPath,
      concurrency: 1,
      clock: () => "2026-09-11T12:00:00.000Z",
      session: {
        async loadContractorLicenseIndex() {
          directoryRequests += 1;
        },
        bootstrapHtml: () => directoryA,
        async fetchPermitDetail(permitNumber) {
          firstDetailRequests.push(permitNumber);
          if (permitNumber === roofRow.permitNumber) throw transient;
          return {
            detail: parsePermitDetailHtml(poolHtml, { expectedPermitNumber: permitNumber }),
            html: poolHtml,
          };
        },
        stats: () => ({}),
      },
    });

    const metadataBefore = await readFile(path.join(root, "license-directory.meta.json"), "utf8");
    const metadata = JSON.parse(metadataBefore);
    const oldRecordBefore = await readFile(
      path.join(root, "extracted", `${poolRow.permitNumber}.json`),
      "utf8",
    );
    expect(directoryRequests).toBe(1);
    expect(firstDetailRequests).toEqual([poolRow.permitNumber, roofRow.permitNumber]);
    expect(JSON.parse(oldRecordBefore).sourcePayload).toMatchObject({
      contractorOfRecordLicense: "POOL-A",
      licenseDirectorySha256: metadata.sha256,
    });

    const resumedDetailRequests = [];
    await harvestPermits({
      jobId,
      artifactRoot: root,
      seedPath,
      concurrency: 1,
      session: {
        async loadContractorLicenseIndex() {
          throw new Error("D2 must not be requested on resume");
        },
        bootstrapHtml: () => directoryB,
        async fetchPermitDetail(permitNumber) {
          resumedDetailRequests.push(permitNumber);
          return {
            detail: parsePermitDetailHtml(roofHtml, { expectedPermitNumber: permitNumber }),
            html: roofHtml,
          };
        },
        stats: () => ({}),
      },
    });

    const newRecord = JSON.parse(
      await readFile(path.join(root, "extracted", `${roofRow.permitNumber}.json`), "utf8"),
    );
    expect(resumedDetailRequests).toEqual([roofRow.permitNumber]);
    expect(await readFile(path.join(root, "license-directory.html"), "utf8")).toBe(directoryA);
    expect(await readFile(path.join(root, "license-directory.meta.json"), "utf8")).toBe(
      metadataBefore,
    );
    expect(
      await readFile(path.join(root, "extracted", `${poolRow.permitNumber}.json`), "utf8"),
    ).toBe(oldRecordBefore);
    expect(newRecord.sourcePayload).toMatchObject({
      contractorOfRecordLicense: "ROOF-A",
      licenseDirectorySha256: metadata.sha256,
    });
  });

  it("recovers an HTML-only pre-record crash by committing a fresh complete pair", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "clermont-license-crash-"));
    const jobId = "clermont-license-crash-test";
    await expect(
      ensureClermontLicenseDirectoryPin({
        root,
        jobId,
        loadSource: async () => ({
          html: directoryA,
          capturedAt: "2026-09-11T12:00:00.000Z",
        }),
        afterHtmlCommit: async () => {
          throw new Error("simulated directory interruption");
        },
      }),
    ).rejects.toThrow(/simulated directory interruption/);
    expect(await readFile(path.join(root, "license-directory.html"), "utf8")).toBe(directoryA);

    const recovered = await ensureClermontLicenseDirectoryPin({
      root,
      jobId,
      loadSource: async () => ({
        html: directoryB,
        capturedAt: "2026-09-11T12:01:00.000Z",
      }),
    });
    expect(recovered.reused).toBe(false);
    expect(recovered.metadata.sha256).toBe(createHash("sha256").update(directoryB).digest("hex"));
    expect(await readFile(path.join(root, "license-directory.html"), "utf8")).toBe(directoryB);
  });

  it("fails closed on metadata or HTML tamper after any completed record", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "clermont-license-tamper-"));
    const jobId = "clermont-license-tamper-test";
    await ensureClermontLicenseDirectoryPin({
      root,
      jobId,
      loadSource: async () => ({
        html: directoryA,
        capturedAt: "2026-09-11T12:00:00.000Z",
      }),
    });
    await mkdir(path.join(root, "extracted"), { recursive: true });
    await writeFile(path.join(root, "extracted", "record.json"), "{}\n");
    const metadataPath = path.join(root, "license-directory.meta.json");
    const originalMetadata = await readFile(metadataPath, "utf8");
    await writeFile(
      metadataPath,
      `${JSON.stringify({ ...JSON.parse(originalMetadata), entries: 99 })}\n`,
    );
    let sourceRequests = 0;
    const reload = async () => {
      sourceRequests += 1;
      return { html: directoryB, capturedAt: "2026-09-11T12:01:00.000Z" };
    };
    await expect(
      ensureClermontLicenseDirectoryPin({ root, jobId, loadSource: reload }),
    ).rejects.toThrow(/invalid after permit capture/);
    expect(sourceRequests).toBe(0);

    await writeFile(metadataPath, originalMetadata);
    await writeFile(path.join(root, "license-directory.html"), `${directoryA}<!-- tamper -->\n`);
    await expect(
      ensureClermontLicenseDirectoryPin({ root, jobId, loadSource: reload }),
    ).rejects.toThrow(/invalid after permit capture/);
    expect(sourceRequests).toBe(0);
  });
});

describe("Clermont offline coverage", () => {
  it("does not invent a parcel identity for permits whose source parcel key is null", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "clermont-coverage-"));
    const extractedRoot = path.join(root, "extracted");
    await Promise.all([
      mkdir(extractedRoot, { recursive: true }),
      mkdir(path.join(root, "dead"), { recursive: true }),
      mkdir(path.join(root, "permit-lists"), { recursive: true }),
    ]);
    const poolHtml = await fixture("permit-detail-with-contractor.html");
    const roofHtml = await fixture("permit-detail-roofing.html");
    const poolRow = parsePermitSearchResults(
      await fixture("permit-search-results-parcel.html"),
    ).rows.at(-1);
    const roofRow = { permitNumber: "24-0009", alternateKey: "3597940" };
    const nullRow = { permitNumber: "24-0010", alternateKey: null };
    const linked = await normalizedFixture({
      html: poolHtml,
      permitNumber: "26-3627",
      row: poolRow,
      alternateKey: "3925114",
      parcelId: "01-22-24-3900-027-00001",
    });
    const unseeded = await normalizedFixture({
      html: roofHtml,
      permitNumber: "24-0009",
      row: roofRow,
      alternateKey: "3597940",
    });
    const withoutParcel = normalizeClermontPermit({
      detail: {
        ...parsePermitDetailHtml(roofHtml, { expectedPermitNumber: "24-0009" }),
        permitNumber: "24-0010",
        alternateKey: null,
      },
      row: nullRow,
      requestedAlternateKey: null,
    });
    await Promise.all(
      [linked, unseeded, withoutParcel].map((record) =>
        writeFile(
          path.join(extractedRoot, `${record.permit_number}.json`),
          `${JSON.stringify(record)}\n`,
        ),
      ),
    );
    await writeFile(
      path.join(root, "permit-lists", "clermont-permit-index.json"),
      `${JSON.stringify({ permitCount: 3, years: ["24", "26"] })}\n`,
    );
    const seedPath = path.join(root, "seed.csv");
    await writeFile(
      seedPath,
      "parcel_id,alt_key,city,address\n01-22-24-3900-027-00001,3925114,CLERMONT,2171 TIMBER CREEK LN\n",
    );

    const coverage = await summarizeCoverage({
      jobId: "offline-coverage-test",
      artifactRoot: root,
      seedPath,
    });
    expect(coverage).toMatchObject({
      permitCount: 3,
      distinctParcels: 2,
      parcelsLinkedToSeed: 1,
      parcelsValidUnlinked: 1,
      permitsLinkedToSeedParcel: 1,
      permitsValidUnlinked: 2,
      permitsWithoutParcelIdentifier: 1,
    });

    await writeFile(path.join(root, "dead", "24-0099.json"), "{}\n");
    await expect(
      summarizeCoverage({ jobId: "offline-coverage-test", artifactRoot: root, seedPath }),
    ).rejects.toThrow();
  });
});
