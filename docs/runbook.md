# Runbook — Lake County, FL

Everything runs from the repository root. Node 22.18+ and the DuckDB CLI are required.
Publishing additionally needs `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` in `.env`; the
Filebase API token is derived from them.

## One-time setup

```bash
(cd .claude/skills/use-oracle/runtime && npm ci)
```

## Verify the runtime before touching the county

This is the bundled runtime's own evidence template. Both replays must report
`publishResult.dryRun: true`.

```bash
npm test --prefix .claude/skills/use-oracle/runtime
node .claude/skills/use-oracle/runtime/bin/elephant-county.mjs replay \
  --county pinellas --fixture .claude/skills/use-oracle/runtime/fixtures/pinellas-replay --output "$(mktemp -d)"
node .claude/skills/use-oracle/runtime/bin/elephant-county.mjs replay \
  --county duval --fixture .claude/skills/use-oracle/runtime/fixtures/duval-replay --output "$(mktemp -d)"
```

## The readiness gate

Non-zero exit stops everything. No seed, no pilot, no ingest.

```bash
python3 .claude/skills/use-oracle/scripts/validate-county-readiness.py \
  .claude/skills/use-oracle/runtime/docs/lake-sources.yaml
```

## A full run

```bash
cd .claude/skills/use-oracle/runtime

# 1. Acquire every source
node scripts/lake/fetch-sources.mjs

# 2. Build the seed CSV, the input of record for every later stage
node --max-old-space-size=6144 scripts/lake/build-seed.mjs

# 3. Consolidate to the query table
D="$PWD/data/downloads/lake"; O="$PWD/data/artifacts/publish/lake/query-table.parquet"
sed -e "s|\$DOWNLOAD_DIR|$D|g" -e "s|\$OUT_PARQUET|$O|g" -e "s|\$AS_OF_YEAR|$(date -u +%Y)|g" \
  scripts/lake/build-query-table.sql > /tmp/lake-qt.sql
duckdb -c ".read /tmp/lake-qt.sql"

# 4. Assemble the publishable run directory
RUNID=$(date -u +%Y%m%dT%H%M%SZ)
node scripts/lake/build-publish-set.mjs --run-id "$RUNID"

# 5. Publish: local DAG, CAR import, IPNS re-point, multi-gateway verification
node --max-old-space-size=6144 scripts/lake/publish-run.mjs --run-id "$RUNID" --mode full
```

Add `--dry-run` to step 5 to compute the root CID, write the CAR and the manifest, and
upload nothing. `--skip-upload` reuses an upload already on Filebase and only re-verifies.

## An incremental run

The permit layer is the only source that moves daily. Window it on `Permit_LastModDate`:

```bash
node scripts/lake/fetch-sources.mjs --only permits --since 2026-09-08
```

then repeat steps 3 to 5 with `--mode incremental`. The run history records per-table
inserted / updated / unchanged / removed counts against the previous run's row hashes, and
refuses to modify or drop any run already recorded.

## A pilot

```bash
node scripts/lake/build-seed.mjs --limit 25 --commercial-first --output data/seeds/lake-pilot.csv
```

then drive the adapter's per-parcel path, which writes `data/<parcel>/transformed.zip` plus a
run manifest with the three-way success / permanent / retryable classification.

## Fetching the published data with nothing but curl

```bash
ROOT=$(jq -r .rootCid artifacts/latest.json)
curl -L "https://ipfs.filebase.io/ipfs/$ROOT/coverage.json" | jq .tables.properties.rows
curl -L "https://gateway.pinata.cloud/ipfs/$ROOT/query-table.parquet" -o query-table.parquet
duckdb -c "SELECT count(*) FROM 'query-table.parquet' WHERE roof_age_years >= 15 AND open_roofing_permit_count > 0"
```
