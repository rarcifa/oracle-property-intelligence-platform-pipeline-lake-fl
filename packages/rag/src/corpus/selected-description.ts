/** Selected-run facts used for descriptions, never inferred from catalog access/certification. */
import { z } from "zod";
import type { Provenance } from "../types.js";

const countSchema = z.number().int().nonnegative().safe();
const descriptionSchema = z.object({
  runId: z.string(),
  sourceObservationsOnly: z.boolean().optional(),
  datasetKind: z.string().optional(),
  currentPermitStatusAccepted: z.boolean().optional(),
  completionAccepted: z.boolean().optional(),
  legalIdentityVerified: z.boolean().optional(),
  tables: z.object({
    contractors: z.object({ rows: countSchema }).optional(),
    permits: z
      .object({
        rows: countSchema,
        bySource: z.record(countSchema).optional(),
        clermontCaptureWindow: z
          .object({
            firstYear: z.number().int(),
            lastYear: z.number().int(),
            allRequiredYearPartitionsCaptured: z.boolean(),
          })
          .optional(),
      })
      .optional(),
  }),
});

export interface SelectedDescription {
  runId: string;
  sourceObservationsOnly: boolean;
  currentPermitStatusAccepted: boolean | null;
  completionAccepted: boolean | null;
  legalIdentityVerified: boolean | null;
  permitSources: Readonly<Record<string, number>> | null;
  contractorNameRows: number | null;
  sourceCountsComplete: boolean;
  clermontCaptureWindow: {
    firstYear: number;
    lastYear: number;
    allRequiredYearPartitionsCaptured: boolean;
  } | null;
  coverage: { provenance: Provenance; sha256: string };
}

/** Called only after the selected coverage bytes and their run identity have been validated. */
export function selectedDescription(
  rawCoverage: unknown,
  coverage: SelectedDescription["coverage"],
): SelectedDescription {
  const parsed = descriptionSchema.parse(rawCoverage);
  if (parsed.runId !== coverage.provenance.runId || !/^[a-f0-9]{64}$/.test(coverage.sha256))
    throw new Error("Selected description requires an exact coverage identity/digest");
  const permitSources = parsed.tables.permits?.bySource ?? null;
  const sum =
    permitSources === null
      ? null
      : Object.values(permitSources).reduce((total, rows) => total + rows, 0);
  if (sum !== null && (sum !== parsed.tables.permits?.rows || !Number.isSafeInteger(sum)))
    throw new Error("Selected permit-source counts do not conserve the permit-table row count");
  return {
    runId: parsed.runId,
    sourceObservationsOnly:
      parsed.sourceObservationsOnly === true || parsed.datasetKind === "source_only_partial",
    currentPermitStatusAccepted: parsed.currentPermitStatusAccepted ?? null,
    completionAccepted: parsed.completionAccepted ?? null,
    legalIdentityVerified: parsed.legalIdentityVerified ?? null,
    permitSources,
    contractorNameRows: parsed.tables.contractors?.rows ?? null,
    sourceCountsComplete: sum !== null,
    clermontCaptureWindow: parsed.tables.permits?.clermontCaptureWindow ?? null,
    coverage,
  };
}

export function selectedDescriptionMetadata(selected: SelectedDescription): Record<string, string> {
  return {
    selectedRunId: selected.runId,
    selectedRootCid: selected.coverage.provenance.rootCid ?? "unpublished",
    selectedCoverageSourceFile: selected.coverage.provenance.sourceFile,
    selectedCoverageSha256: selected.coverage.sha256,
    sourceObservationsOnly: String(selected.sourceObservationsOnly),
    currentPermitStatusAccepted: String(selected.currentPermitStatusAccepted ?? "unknown"),
    completionAccepted: String(selected.completionAccepted ?? "unknown"),
    legalIdentityVerified: String(selected.legalIdentityVerified ?? "unknown"),
  };
}

export const PERMIT_SOURCE_BY_JURISDICTION: Readonly<Record<string, string>> = {
  unincorporated: "lake_cdplus_permits",
  clermont: "lake_clermont_etrakit_permits",
};

export function selectedJurisdictionRows(
  selected: SelectedDescription,
  key: string,
): number | null {
  if (!selected.permitSources) return null;
  const source = PERMIT_SOURCE_BY_JURISDICTION[key];
  if (source !== undefined && Object.hasOwn(selected.permitSources, source))
    return selected.permitSources[source]!;
  const mappedSources = new Set(Object.values(PERMIT_SOURCE_BY_JURISDICTION));
  return selected.sourceCountsComplete &&
    Object.keys(selected.permitSources).every((name) => mappedSources.has(name))
    ? 0
    : null;
}

export function selectedPermitBoundary(selected: SelectedDescription): string {
  if (selected.sourceObservationsOnly)
    return "Retained historical source observations are loaded, not accepted current-open status, open duration, roofing classification, completion, or verified legal-company/license identity. These conclusions remain unknown, not zero or false.";
  return `Acceptance is separate from acquisition: current permit status ${selected.currentPermitStatusAccepted ?? "unknown"}, completion ${selected.completionAccepted ?? "unknown"}, verified legal identity ${selected.legalIdentityVerified ?? "unknown"}. Historical capture alone does not establish today's status or effective licensing.`;
}
