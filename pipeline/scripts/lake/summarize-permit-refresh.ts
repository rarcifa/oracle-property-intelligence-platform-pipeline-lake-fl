import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const permitSchema = z
  .object({
    permit_number: z.string().trim().min(1),
    alternate_key: z.string().nullable(),
  })
  .passthrough();
const permitsSchema = z.array(permitSchema);
type Permit = z.infer<typeof permitSchema>;

function key(permit: Permit): string {
  return `${permit.permit_number}::${permit.alternate_key ?? ""}`;
}

function signature(permit: Permit): string {
  // Runtime-derived age is not a source-record update.
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(permit)
        .filter(([name]) => name !== "days_open")
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
}

export function reconcilePermitRefresh(
  base: readonly Permit[],
  window: readonly Permit[],
  merged: readonly Permit[],
): {
  baseAssociations: number;
  windowAssociations: number;
  mergedAssociations: number;
  inserted: number;
  updated: number;
  unchangedInWindow: number;
  removed: null;
  idempotent: true;
} {
  const before = new Map(base.map((record) => [key(record), record]));
  const changes = new Map(window.map((record) => [key(record), record]));
  const expected = new Map([...before, ...changes]);
  const actual = new Map(merged.map((record) => [key(record), record]));
  if (actual.size !== merged.length || expected.size !== actual.size)
    throw new Error("Incremental reconciliation has duplicate or missing association keys");
  for (const [recordKey, record] of expected) {
    const retained = actual.get(recordKey);
    if (!retained || signature(record) !== signature(retained))
      throw new Error("Incremental reconciliation lost or changed source evidence");
  }
  let inserted = 0;
  let updated = 0;
  let unchangedInWindow = 0;
  for (const [recordKey, record] of changes) {
    const prior = before.get(recordKey);
    if (!prior) inserted += 1;
    else if (signature(prior) !== signature(record)) updated += 1;
    else unchangedInWindow += 1;
  }
  const rerun = new Map([...actual, ...changes]);
  if (
    rerun.size !== actual.size ||
    [...rerun].some(
      ([recordKey, record]) => signature(record) !== signature(actual.get(recordKey)!),
    )
  ) {
    throw new Error("Incremental refresh is not idempotent");
  }
  return {
    baseAssociations: before.size,
    windowAssociations: changes.size,
    mergedAssociations: actual.size,
    inserted,
    updated,
    unchangedInWindow,
    removed: null,
    idempotent: true,
  };
}

async function main(): Promise<void> {
  const [basePath, refreshDir] = process.argv.slice(2);
  if (!basePath || !refreshDir)
    throw new Error(
      "usage: summarize-permit-refresh.ts <immutable-base.json> <isolated-refresh-dir>",
    );
  const paths = [
    basePath,
    path.join(refreshDir, "permits-window.json"),
    path.join(refreshDir, "permits.json"),
    path.join(refreshDir, "permit-source-observations-window.json"),
  ];
  const bodies = await Promise.all(paths.map((input) => readFile(input)));
  const [base, window, merged] = z
    .tuple([permitsSchema, permitsSchema, permitsSchema])
    .parse(bodies.slice(0, 3).map((body) => JSON.parse(body.toString("utf8"))));
  const source = z
    .object({
      capturedAt: z.string().datetime(),
      source: z.string().url(),
      where: z.string(),
      objectIds: z.array(z.number()),
      features: z.array(z.record(z.string(), z.unknown())),
    })
    .parse(JSON.parse(bodies[3]!.toString("utf8")));
  if (
    source.objectIds.length !== source.features.length ||
    window.length !== source.features.length
  )
    throw new Error("Refresh capture did not reconcile the enumerated window");
  const readback = {
    schemaVersion: "elephant.lake-permit-refresh-readback.v1",
    capturedAt: source.capturedAt,
    source: source.source,
    where: source.where,
    sourceFeatures: source.features.length,
    distinctWindowPermits: new Set(window.map((record) => record.permit_number)).size,
    deltas: reconcilePermitRefresh(base, window, merged),
    bindings: paths.map((input, index) => ({
      role: ["immutable-base", "window", "merged", "source-observations"][index],
      sizeBytes: bodies[index]!.length,
      sha256: createHash("sha256").update(bodies[index]!).digest("hex"),
    })),
    limitations: [
      "A window cannot prove source deletions; removed is unknown.",
      "Only records in this fresh window have this observation time. Historical Clermont timestamps remain unknown.",
      "Source classifications are not proof of primary-roof replacement or contractor legal identity.",
      "This receipt does not establish IPFS publication or current status for every retained permit.",
    ],
  };
  const outputPath = path.join(refreshDir, "incremental-readback.json");
  await writeFile(outputPath, `${JSON.stringify(readback, null, 2)}\n`, { mode: 0o600 });
  console.log(
    JSON.stringify({
      outputPath,
      capturedAt: readback.capturedAt,
      sourceFeatures: readback.sourceFeatures,
      distinctWindowPermits: readback.distinctWindowPermits,
      deltas: readback.deltas,
    }),
  );
}

if (process.argv[1]?.endsWith("summarize-permit-refresh.ts")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Refresh failed");
    process.exitCode = 1;
  });
}
