/** Retain every official TPP account; public projection and raw payload stay separate. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const SOURCE_URL = "https://floridarevenue.com/property/dataportal";
const SOURCE_SYSTEM = "fl_dor_tpp_2026p";
const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

export interface BusinessBuildOptions {
  tppPath: string;
  nalPath: string;
  output: string;
  duckdb?: string;
  expectedAccounts?: number;
}

/** A new immutable operator directory is required, never an earlier publication. */
export async function buildBusinessTable(
  options: BusinessBuildOptions,
): Promise<Record<string, unknown>> {
  const [tppPath, nalPath] = await Promise.all([
    realpath(options.tppPath),
    realpath(options.nalPath),
  ]);
  const output = path.resolve(options.output);
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const outputParent = await realpath(path.dirname(output));
  const resolvedOutput = path.join(outputParent, path.basename(output));
  if (resolvedOutput === repo || resolvedOutput.startsWith(`${repo}${path.sep}`)) {
    throw new Error("Business source/derivative output must stay outside Git");
  }
  if ([tppPath, nalPath].some((input) => resolvedOutput === input)) {
    throw new Error("Business output cannot overwrite a source input");
  }
  const [tppBytes, nalBytes] = await Promise.all([readFile(tppPath), readFile(nalPath)]);
  const tppSha256 = digest(tppBytes);
  const nalSha256 = digest(nalBytes);
  const setup = `CREATE VIEW tpp AS SELECT * FROM read_csv_auto(${quote(tppPath)}, header=true, all_varchar=true);
    CREATE VIEW nal AS SELECT * FROM read_csv_auto(${quote(nalPath)}, header=true, all_varchar=true);`;
  const run = async (sql: string): Promise<Record<string, unknown>[]> => {
    const { stdout } = await execute(options.duckdb ?? "duckdb", ["-json", "-c", sql], {
      maxBuffer: 8 * 1024 * 1024,
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !/^(AWS_|DATABASE_URL|FILEBASE_|PINATA_|OPENAI_)/.test(key),
        ),
      ),
    });
    return stdout.trim() ? (JSON.parse(stdout) as Record<string, unknown>[]) : [];
  };
  const [gate] =
    await run(`${setup} SELECT count(*) AS rows, count(DISTINCT trim(ACCT_ID)) AS distinct_accounts,
    count(*) FILTER (WHERE nullif(trim(ACCT_ID), '') IS NULL OR trim(CO_NO) IS DISTINCT FROM '45') AS invalid_keys
    FROM tpp;`);
  if (
    !gate ||
    Number(gate.rows) !== (options.expectedAccounts ?? 33346) ||
    Number(gate.rows) !== Number(gate.distinct_accounts) ||
    Number(gate.invalid_keys) !== 0
  ) {
    throw new Error("TPP account identity/count/county reconciliation failed");
  }
  await mkdir(resolvedOutput, { recursive: false, mode: 0o700 });
  const publicPath = path.join(resolvedOutput, "business-table.parquet");
  const payloadPath = path.join(resolvedOutput, "private-business-source-payload.jsonl");
  const sql = `${setup}
    CREATE VIEW parcel_situs AS SELECT upper(trim(PHY_ADDR1)) AS addr, trim(PHY_ZIPCD) AS zip,
      count(*)::INTEGER AS matched_parcel_count,
      to_json(list(PARCEL_ID ORDER BY PARCEL_ID))::VARCHAR AS matched_parcel_ids
      FROM nal WHERE nullif(trim(PHY_ADDR1), '') IS NOT NULL GROUP BY 1, 2;
    CREATE TABLE businesses AS SELECT
      'lake:fl_dor_tpp:' || trim(t.ACCT_ID) AS business_id,
      'lake'::VARCHAR AS county, trim(t.ACCT_ID) AS account_id,
      try_cast(t.ASMNT_YR AS INTEGER) AS assessment_year,
      nullif(trim(t.OWN_NAM), '') AS business_name,
      nullif(trim(t.NAICS_CD), '') AS naics_code,
      nullif(trim(t.PHY_ADDR), '') AS situs_address,
      nullif(trim(t.PHY_CITY), '') AS situs_city,
      nullif(trim(t.PHY_ZIPCD), '') AS situs_zip,
      coalesce(p.matched_parcel_count, 0)::INTEGER AS matched_parcel_count,
      coalesce(p.matched_parcel_ids, '[]')::VARCHAR AS matched_parcel_ids,
      'normalized_situs_street_and_zip_candidate; not legal identity'::VARCHAR AS match_basis,
      ${quote(SOURCE_URL)}::VARCHAR AS source_url, ${quote(SOURCE_SYSTEM)}::VARCHAR AS source_system,
      ${quote(tppSha256)}::VARCHAR AS source_input_sha256
      FROM tpp t LEFT JOIN parcel_situs p ON p.addr = upper(trim(t.PHY_ADDR)) AND p.zip = trim(t.PHY_ZIPCD);
    COPY (SELECT * FROM businesses ORDER BY business_id) TO ${quote(publicPath)} (FORMAT PARQUET, COMPRESSION ZSTD);
    COPY (SELECT 'lake:fl_dor_tpp:' || trim(t.ACCT_ID) AS business_id,
      ${quote(tppSha256)} AS source_input_sha256, to_json(t) AS source_payload
      FROM tpp t ORDER BY business_id) TO ${quote(payloadPath)} (FORMAT JSON);
    SELECT count(*) AS source_accounts,
      count(*) FILTER (WHERE matched_parcel_count > 0) AS matched_accounts,
      count(*) FILTER (WHERE matched_parcel_count = 0) AS valid_unmatched_accounts,
      coalesce(sum(matched_parcel_count), 0) AS account_parcel_attributions,
      count(*) FILTER (WHERE situs_address IS NOT NULL) AS accounts_with_situs
      FROM read_parquet(${quote(publicPath)});`;
  const [counts] = await run(sql);
  if (
    !counts ||
    Number(counts.source_accounts) !== Number(gate.rows) ||
    Number(counts.matched_accounts) + Number(counts.valid_unmatched_accounts) !== Number(gate.rows)
  ) {
    throw new Error("Business output readback failed account reconciliation");
  }
  const [afterTpp, afterNal, publicBytes, payloadBytes] = await Promise.all([
    readFile(tppPath),
    readFile(nalPath),
    readFile(publicPath),
    readFile(payloadPath),
  ]);
  if (digest(afterTpp) !== tppSha256 || digest(afterNal) !== nalSha256)
    throw new Error("Business inputs changed during build");
  const receipt = {
    schemaVersion: "oracle.lake-business-account-build.v1",
    transformedAt: new Date().toISOString(),
    source: {
      url: SOURCE_URL,
      system: SOURCE_SYSTEM,
      postedAt: null,
      retrievedAt: null,
      sha256: tppSha256,
      size: tppBytes.length,
    },
    nalSha256,
    counts,
    publicArtifact: { path: publicPath, sha256: digest(publicBytes), size: publicBytes.length },
    privatePayload: { path: payloadPath, sha256: digest(payloadBytes), size: payloadBytes.length },
    caveat:
      "Source retrieval/posted time is unproven; transformation time is not collection time. Associations are address candidates, not legal identity. Raw payload and owner/fiduciary contacts must not be published.",
  };
  await writeFile(
    path.join(resolvedOutput, "business-reconciliation.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { mode: 0o600 },
  );
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    const value = process.argv[index + 1];
    if (!key || !value || !["--tpp", "--nal", "--output", "--duckdb"].includes(key))
      throw new Error("Invalid business build arguments");
    args.set(key, value);
  }
  const tppPath = args.get("--tpp");
  const nalPath = args.get("--nal");
  const output = args.get("--output");
  if (!tppPath || !nalPath || !output)
    throw new Error("Require --tpp, --nal and new private --output");
  const receipt = await buildBusinessTable({
    tppPath,
    nalPath,
    output,
    duckdb: args.get("--duckdb"),
  });
  process.stdout.write(
    `${JSON.stringify({ counts: receipt.counts, publicArtifact: receipt.publicArtifact })}\n`,
  );
}
