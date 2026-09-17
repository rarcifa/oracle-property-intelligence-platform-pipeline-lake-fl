/** Local-only integration of a previously captured, byte-bound CD Plus window. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { renderCsv } from "../../src/core/csv.mjs";
import { normalizePermit } from "../../src/counties/lake/sources.mjs";
import { buildSourceOnlyExport } from "./build-source-only-export.js";
import { reconcilePermitRefresh } from "./summarize-permit-refresh.js";

const execute = promisify(execFile);
const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const quote = (value: string): string => value.replaceAll("'", "''");
const bindingSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().nonnegative(),
});
const captureSchema = z.object({
  capturedAt: z.string().datetime(),
  source: z.string().url(),
  where: z.string(),
  objectIds: z.array(z.number().int()),
  features: z.array(z.record(z.string(), z.unknown())),
});
const permitsSchema = z.array(
  z
    .object({ permit_number: z.string().trim().min(1), alternate_key: z.string().nullable() })
    .passthrough(),
);
const configSchema = z.object({
  runId: z.string().regex(/^\d{8}T\d{6}Z$/),
  asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  output: z.string().min(1),
  sourceInputs: z.array(bindingSchema.extend({ name: z.string() })).length(7),
  baseProperty: bindingSchema,
  basePermit: bindingSchema,
  baseBusiness: bindingSchema,
  basePermitJson: bindingSchema,
  window: bindingSchema,
  merged: bindingSchema,
  sourceObservations: bindingSchema,
  refreshReceipt: bindingSchema,
  expectedProperties: z.number().int().positive().default(215806),
  expectedBusinesses: z.number().int().positive().default(33346),
});
export type IncrementalSourceOnlyOptions = z.input<typeof configSchema>;
const SOURCE_NAMES = [
  "NAL45P202601.csv",
  "SDF45P202601.csv",
  "NAP45P202601.csv",
  "centroids.csv",
  "permits.csv",
  "clermont-permits.csv",
  "clermont-permits.meta.json",
];
const PERMIT_COLUMNS = [
  "permit_number",
  "alternate_key",
  "parcel_id",
  "permit_type",
  "permit_desc",
  "permit_status",
  "applied_date",
  "approved_date",
  "issued_date",
  "co_date",
  "last_modified",
  "permit_url",
  "is_roofing",
  "is_open",
  "days_open",
];

export async function buildIncrementalSourceOnlyTables(input: IncrementalSourceOnlyOptions) {
  const config = configSchema.parse(input);
  if (
    !Number.isFinite(Date.parse(`${config.asOfDate}T00:00:00Z`)) ||
    new Date(`${config.asOfDate}T00:00:00Z`).toISOString().slice(0, 10) !== config.asOfDate
  )
    throw new Error("Invalid incremental as-of date");
  if (config.sourceInputs.some((binding, index) => binding.name !== SOURCE_NAMES[index]))
    throw new Error("Require the exact ordered frozen Lake source inputs");
  const bindings = [
    ...config.sourceInputs,
    config.baseProperty,
    config.basePermit,
    config.baseBusiness,
    config.basePermitJson,
    config.window,
    config.merged,
    config.sourceObservations,
    config.refreshReceipt,
  ];
  const bodies = new Map<string, Buffer>();
  for (const binding of bindings) {
    const bytes = await readFile(binding.path);
    if (bytes.length !== binding.sizeBytes || sha(bytes) !== binding.sha256)
      throw new Error("Frozen incremental input digest/size mismatch");
    bodies.set(binding.path, bytes);
  }
  const parsed = (binding: z.infer<typeof bindingSchema>): unknown =>
    JSON.parse(bodies.get(binding.path)!.toString("utf8"));
  const base = permitsSchema.parse(parsed(config.basePermitJson));
  const window = permitsSchema.parse(parsed(config.window));
  const merged = permitsSchema.parse(parsed(config.merged));
  const csvFor = (rows: typeof merged): string =>
    renderCsv(
      PERMIT_COLUMNS,
      rows.map((permit) =>
        Object.fromEntries(
          PERMIT_COLUMNS.map((column) => [
            column,
            permit[column] == null ? "" : String(permit[column]),
          ]),
        ),
      ),
    );
  if (csvFor(base) !== bodies.get(config.sourceInputs[4]!.path)!.toString("utf8"))
    throw new Error("Frozen base JSON and query source CSV contradict each other");
  const observations = captureSchema.parse(parsed(config.sourceObservations));
  if (
    new Set(observations.objectIds).size !== observations.objectIds.length ||
    observations.objectIds.length !== observations.features.length ||
    window.length !== observations.features.length ||
    observations.features.some(
      (feature, index) => feature.OBJECTID !== observations.objectIds[index],
    )
  )
    throw new Error("Captured incremental OBJECTID window does not reconcile");
  const observedWindow = observations.features.map((attributes) =>
    normalizePermit(attributes, { nowMs: Date.parse(observations.capturedAt) }),
  );
  const signature = (row: Record<string, unknown>): string =>
    JSON.stringify(
      Object.fromEntries(
        Object.entries(row)
          .filter(([name]) => name !== "days_open")
          .sort(([left], [right]) => left.localeCompare(right)),
      ),
    );
  if (observedWindow.some((row, index) => signature(row) !== signature(window[index]!)))
    throw new Error("Normalized incremental window contradicts captured source observations");
  const deltas = reconcilePermitRefresh(base, window, merged);
  const receiptSchema = z.object({
    schemaVersion: z.literal("elephant.lake-permit-refresh-readback.v1"),
    capturedAt: z.string(),
    source: z.string(),
    where: z.string(),
    sourceFeatures: z.number(),
    distinctWindowPermits: z.number(),
    deltas: z.object({
      baseAssociations: z.number(),
      windowAssociations: z.number(),
      mergedAssociations: z.number(),
      inserted: z.number(),
      updated: z.number(),
      unchangedInWindow: z.number(),
      removed: z.null(),
      idempotent: z.literal(true),
    }),
    bindings: z.array(z.object({ role: z.string(), sizeBytes: z.number(), sha256: z.string() })),
  });
  const refresh = receiptSchema.parse(parsed(config.refreshReceipt));
  if (
    JSON.stringify(refresh.deltas) !== JSON.stringify(deltas) ||
    refresh.capturedAt !== observations.capturedAt ||
    refresh.source !== observations.source ||
    refresh.where !== observations.where ||
    refresh.sourceFeatures !== observations.features.length ||
    refresh.distinctWindowPermits !== new Set(window.map((row) => row.permit_number)).size
  )
    throw new Error("Captured incremental receipt contradicts actual frozen records");
  for (const [index, binding] of [
    config.basePermitJson,
    config.window,
    config.merged,
    config.sourceObservations,
  ].entries()) {
    const recorded = refresh.bindings.find(
      (item) => item.role === ["immutable-base", "window", "merged", "source-observations"][index],
    );
    if (!recorded || recorded.sizeBytes !== binding.sizeBytes || recorded.sha256 !== binding.sha256)
      throw new Error("Captured incremental receipt input binding mismatch");
  }
  // Association ambiguity must never silently drop a valid parcel relationship.
  for (const rows of [base, merged])
    if (new Set(rows.map((row) => row.permit_number)).size !== rows.length)
      throw new Error("Multiple parcel associations need an explicit existing integration route");
  const output = path.join(
    await realpath(path.dirname(path.resolve(config.output))),
    path.basename(config.output),
  );
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const roots = await Promise.all(
    bindings.map(async (binding) => path.dirname(await realpath(binding.path))),
  );
  if (
    output === repo ||
    output.startsWith(`${repo}${path.sep}`) ||
    roots.some((root) => output === root || output.startsWith(`${root}${path.sep}`))
  )
    throw new Error(
      "Require a new private incremental output outside Git and immutable input roots",
    );
  await mkdir(output, { mode: 0o700, recursive: false });
  const downloads = path.join(output, "downloads");
  await mkdir(downloads, { mode: 0o700 });
  for (const binding of config.sourceInputs)
    if (binding.name !== "permits.csv")
      await copyFile(binding.path, path.join(downloads, binding.name));
  const csv = csvFor(merged);
  await writeFile(path.join(downloads, "permits.csv"), csv, { mode: 0o600 });
  const run = async (sql: string): Promise<Record<string, unknown>[]> => {
    const { stdout } = await execute("duckdb", ["-json", "-c", sql], {
      timeout: 180000,
      maxBuffer: 8 * 1024 * 1024,
      env: { PATH: process.env.PATH, TZ: "UTC", LANG: "C" },
    });
    return stdout.trim() ? (JSON.parse(stdout) as Record<string, unknown>[]) : [];
  };
  const [baseline] = await run(`SELECT
    (SELECT count(*) FROM read_parquet('${quote(config.basePermit.path)}') WHERE source_system='lake_clermont_etrakit_permits') AS clermont,
    (SELECT count(*) FROM read_parquet('${quote(config.basePermit.path)}') WHERE source_system='lake_cdplus_permits') AS cdplus,
    (SELECT count(*) FROM read_parquet('${quote(config.basePermit.path)}')) AS permits;`);
  if (
    !baseline ||
    Number(baseline.cdplus) !== base.length ||
    Number(baseline.permits) !== base.length + Number(baseline.clermont)
  )
    throw new Error("Frozen source-only base permit sources do not reconcile");
  const rawProperty = path.join(output, "private-query-input.parquet");
  const rawPermit = path.join(output, "private-permit-input.parquet");
  const template = await readFile(new URL("./build-query-table.sql", import.meta.url), "utf8");
  await run(
    template
      .replaceAll("$DOWNLOAD_DIR", quote(downloads))
      .replaceAll("$PERMIT_OUT_PARQUET", quote(rawPermit))
      .replaceAll("$OUT_PARQUET", quote(rawProperty))
      .replaceAll("$AS_OF_YEAR", config.asOfDate.slice(0, 4))
      .replaceAll("$AS_OF_DATE", quote(config.asOfDate)),
  );
  const sourceOnly = await buildSourceOnlyExport({
    propertyInput: rawProperty,
    propertySha256: sha(await readFile(rawProperty)),
    permitInput: rawPermit,
    permitSha256: sha(await readFile(rawPermit)),
    businessInput: config.baseBusiness.path,
    businessSha256: config.baseBusiness.sha256,
    output: path.join(output, "source-only"),
    runId: config.runId,
    asOfDate: config.asOfDate,
    expectedProperties: config.expectedProperties,
    expectedPermits: merged.length + Number(baseline.clermont),
    expectedBusinesses: config.expectedBusinesses,
  });
  const laterProperty = path.join(output, "source-only", "query-table.parquet");
  const laterPermit = path.join(output, "source-only", "permit-table.parquet");
  const [equality] =
    await run(`WITH before AS (SELECT * FROM read_parquet('${quote(config.baseProperty.path)}')),
    after AS (SELECT * FROM read_parquet('${quote(laterProperty)}')),
    retained_before AS (SELECT * FROM read_parquet('${quote(config.basePermit.path)}') WHERE source_system='lake_clermont_etrakit_permits'),
    retained_after AS (SELECT * FROM read_parquet('${quote(laterPermit)}') WHERE source_system='lake_clermont_etrakit_permits')
    SELECT
      (SELECT count(*) FROM ((SELECT * EXCLUDE (has_permits,permit_count,latest_permit_date,source_systems) FROM before EXCEPT ALL SELECT * EXCLUDE (has_permits,permit_count,latest_permit_date,source_systems) FROM after) UNION ALL (SELECT * EXCLUDE (has_permits,permit_count,latest_permit_date,source_systems) FROM after EXCEPT ALL SELECT * EXCLUDE (has_permits,permit_count,latest_permit_date,source_systems) FROM before))) AS unrelated_property_changes,
      (SELECT count(*) FROM ((SELECT * FROM retained_before EXCEPT ALL SELECT * FROM retained_after) UNION ALL (SELECT * FROM retained_after EXCEPT ALL SELECT * FROM retained_before))) AS retained_clermont_changes,
      (SELECT count(*) FROM after) AS properties,
      (SELECT count(*) FROM retained_after) AS clermont;`);
  if (
    !equality ||
    Number(equality.unrelated_property_changes) !== 0 ||
    Number(equality.retained_clermont_changes) !== 0 ||
    Number(equality.clermont) !== Number(baseline.clermont)
  )
    throw new Error(
      "Incremental export changed unrelated properties or frozen Clermont source-only observations",
    );
  for (const binding of bindings) {
    const bytes = await readFile(binding.path);
    if (bytes.length !== binding.sizeBytes || sha(bytes) !== binding.sha256)
      throw new Error("Frozen incremental inputs changed during export");
  }
  const integration = {
    schemaVersion: "oracle.lake-source-only-incremental-build.v1",
    runId: config.runId,
    publicationState: "held_local_candidate",
    published: false,
    countyComplete: false,
    sourceObservationsOnly: true,
    currentPermitStatusAccepted: false,
    completionAccepted: false,
    legalIdentityVerified: false,
    sourceCapture: {
      capturedAt: observations.capturedAt,
      source: observations.source,
      where: observations.where,
      sourceFeatures: observations.features.length,
      observedPermitIds: [
        ...new Set(window.map((row) => `lake_cdplus_permits:${row.permit_number}`)),
      ].sort(),
    },
    deltas,
    counts: sourceOnly.counts,
    recordEquality: equality,
    immutableInputsUnchanged: true,
    inputBindings: bindings.map((binding) => ({
      name: "name" in binding ? binding.name : path.basename(binding.path),
      sha256: binding.sha256,
      sizeBytes: binding.sizeBytes,
    })),
    sourceOnlyFiles: sourceOnly.outputFiles,
    limitations: [
      "Only the listed CD Plus window permit IDs carry this fresh source observation; retained Clermont and older CD Plus capture times remain unchanged or unknown.",
      "Windowing cannot prove deletions. Source descriptions/status text do not establish accepted roof completion, current-open duration, license/legal identity or BBB scores.",
      "New CIDs are local candidate identities, not evidence of IPFS publication or pointer/history promotion.",
    ],
  };
  await writeFile(
    path.join(output, "incremental-integration.json"),
    `${JSON.stringify(integration, null, 2)}\n`,
    { mode: 0o600 },
  );
  return { output, downloads, sourceOnly: path.join(output, "source-only"), integration };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(
    await readFile(process.argv[2] ?? "", "utf8"),
  ) as IncrementalSourceOnlyOptions;
  const result = await buildIncrementalSourceOnlyTables(config);
  process.stdout.write(
    `${JSON.stringify({
      output: result.output,
      sourceOnly: result.sourceOnly,
      counts: result.integration.counts,
      deltas: result.integration.deltas,
      recordEquality: result.integration.recordEquality,
    })}\n`,
  );
}
