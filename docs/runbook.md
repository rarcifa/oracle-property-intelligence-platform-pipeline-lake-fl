# Runbook — Lake County, FL

Everything runs from the repository root. Node 22.18+ within major 22 and the DuckDB CLI are
required.
Credentials alone never enable publication. A live release additionally needs Filebase
credentials and a short-lived Ed25519 authorization for the exact frozen target.

## One-time setup

```bash
pnpm install --frozen-lockfile
(cd pipeline && npm ci)
```

## Durable Clermont control plane

The private baseline stack already exists in AWS account `122610508924`, region `us-east-2`,
but its bucket is empty and the current alerting/storage hardening is not deployed. Update it
only after this repair is committed and the owner approves that exact commit:

```bash
cd pipeline
npx cdk deploy ClermontBaselineStack \
  -c alertEmail=rarcifa@gmail.com \
  --parameters ClermontBaselineStack:BaselineOperatorArn=arn:aws:iam::122610508924:user/etl
```

The SNS-only deployment is the approved current configuration. Confirm the email subscription,
then set `CLERMONT_ALERT_TOPIC_ARN`, `CLERMONT_BASELINE_READ_ROLE_ARN`, and
`CLERMONT_BASELINE_S3_URI` from the stack outputs, and set
`CLERMONT_BASELINE_AWS_REGION=us-east-2`. It sends
failure email but does not page. Full kit conformance additionally requires a PagerDuty routing
key stored in production Secrets Manager, a redeploy with `-c pagerDutySecretArn=<exact-arn>`,
and `CLERMONT_FAILURE_NOTIFIER_ARN` set from the output. Never put the routing key in GitHub.
For the approved SNS-only deviation, pass `--failure-topic-arn "$CLERMONT_ALERT_TOPIC_ARN"`
to `clermont:run` instead. The CLI requires exactly one of the SNS or PagerDuty transports and
durably arms notification before acquisition and converts it to pending only when the current
pass advances into `FAILED_EXHAUSTED`. This closes the terminal-write crash window. Transport
failures are retried within a bounded pass and on a later operator rerun while pending; a
recorded accepted receipt suppresses further notification.
Failure to load the coordinator snapshot or persist the arm stops the pass before acquisition.
Candidate preparation also requires repository variable
`IPNS_PREDECESSOR_RECEIPT_JSON_B64`: the base64 encoding of the reviewed Filebase names object
described in step 5. It contains public pointer identity, not a credential. Refresh it after
every successful IPNS update; a missing, stale, or wrong label/network key fails before a
publication request is created.

## Verify the runtime before touching the county

This is the bundled runtime's own evidence template. Both replays must report
`publishResult.dryRun: true`.

```bash
npm test --prefix pipeline
node pipeline/bin/elephant-county.mjs replay \
  --county pinellas --fixture pipeline/fixtures/pinellas-replay --output "$(mktemp -d)"
node pipeline/bin/elephant-county.mjs replay \
  --county duval --fixture pipeline/fixtures/duval-replay --output "$(mktemp -d)"
```

## The readiness gate

Non-zero exit stops everything. No seed, no pilot, no ingest.

```bash
python3 pipeline/scripts/validate-county-readiness.py \
  pipeline/docs/lake-sources.yaml
```

## Plan the complete Clermont history before a full run

The portal exposes one partition per permit year from 2015 through 2026. The repaired
local candidate contains **year 26 only**. Do not label its 4,061/4,061 achievable rows as
all available Clermont history.

Create an intended prepare template with `authorization: null`. It must bind the exact Node
runtime, AWS account/region/bucket/prefix, fixed 150 GiB retained-storage ceiling, concurrency 2,
benchmark, baseline, retry policy, and cost limits. Preview it without acquiring data:

```bash
cd pipeline
npm run clermont:prepare -- \
  --repo-root .. \
  --template /secure/operator/clermont-full-template.preview.json \
  --run-store /secure/operator/clermont-preview-run-store \
  --baseline-store data/baselines/lake/clermont \
  --now "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

The JSON output includes the exact `authorizationScopeSha256`, `provenanceSha256`, and
conservative estimate. If approval is required, put those exact values, a unique
`authorizationId`, the same `runId`, explicit hour/cost caps, approver, and expiry into a fresh
template, then run `clermont:prepare` again into the durable run store. Never execute the preview
store. The estimate uses maximum attempts and all 12 partition bounds. The coordinator enters
`WAITING_HUMAN` when it exceeds 48 hours or the request's cost ceiling; execution consumes the
exact authorization nonce once and enforces one durable deadline across resumes. A sustained
harvest, AWS job, source reprobe, or cost approval is an external action; none is implied by
preparation. See
[`pipeline/config/clermont/README.md`](../pipeline/config/clermont/README.md) for the
partition and handoff invariants.

## Build a full local candidate

```bash
cd pipeline

# 1. Acquire every source
node scripts/lake/fetch-sources.mjs

# 2. Build the seed CSV, the input of record for every later stage
node --max-old-space-size=6144 scripts/lake/build-seed.mjs

# 2b. Materialize the exact certified 2015-2026 last-good Clermont baseline.
#     This validates the pointer, source/config/schema signatures, all 12
#     partition receipts and every digest before atomically replacing the CSV.
#     There is no empty fallback and the year-26 local export is not a substitute.
npm run clermont:materialize -- \
  --consumption-request /secure/operator/clermont-consumption-request.json \
  --baseline-store data/baselines/lake/clermont \
  --output-root .. \
  --now "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

D="$PWD/data/downloads/lake"

# 3. Consolidate to the query table
O="$PWD/data/artifacts/publish/lake/query-table.parquet"
P="$PWD/data/artifacts/publish/lake/permit-table.parquet"
sed -e "s|\$DOWNLOAD_DIR|$D|g" -e "s|\$OUT_PARQUET|$O|g" \
  -e "s|\$PERMIT_OUT_PARQUET|$P|g" -e "s|\$AS_OF_YEAR|$(date -u +%Y)|g" \
  -e "s|\$AS_OF_DATE|$(date -u +%F)|g" \
  scripts/lake/build-query-table.sql > /tmp/lake-qt.sql
duckdb -c ".read /tmp/lake-qt.sql"

# 4. Assemble the publishable run directory
RUNID=$(date -u +%Y%m%dT%H%M%SZ)
BASELINE_DIGEST=$(jq -er '.baselineSha256' \
  /secure/operator/clermont-consumption-request.json)
node scripts/lake/build-publish-set.mjs \
  --run-id "$RUNID" \
  --clermont-baseline-sha256 "$BASELINE_DIGEST" \
  --clermont-evidence \
  "data/baselines/lake/clermont/baselines/$BASELINE_DIGEST/baseline.json"

# 5. Prepare locally: validate, build deterministic CARs and emit the exact target request.
#    The helper recursively discovers the publication closure and rejects any component
#    that is untracked, absent from COMMIT, or not byte-identical to `git show COMMIT:path`.
#    Generated run artifacts and receipts may be dirty; executable provenance components may not.
COMMIT="$(git -C .. rev-parse HEAD)"
PROVENANCE_JSON="$(mktemp)"
node scripts/lake/publication-provenance.mjs \
  --candidate-commit "$COMMIT" > "$PROVENANCE_JSON"
PROVENANCE_DIGEST="$(jq -er '.digest' "$PROVENANCE_JSON")"
rm -f "$PROVENANCE_JSON"

# This private receipt is the selected object from a read-only snapshot of
# GET https://api.filebase.io/v1/names. It must carry the exact existing identity.
IPNS_RECEIPT=/secure/operator/lake-ipns-predecessor.json
jq -e \
  '.label == "oracle-open-data-lake" and
   .network_key == "k51qzi5uqu5dgd1ekyyuhwggov571fjxof2p5ef4ke7enlq60k03r47fosb2un"' \
  "$IPNS_RECEIPT" >/dev/null
IPNS_PREDECESSOR_CID="$(jq -er '.cid' "$IPNS_RECEIPT")"
IPNS_PREDECESSOR_SEQUENCE="$(jq -er '.sequence | select(type == "number" and . >= 0 and floor == .)' "$IPNS_RECEIPT")"
node --max-old-space-size=6144 scripts/lake/publish-run.mjs \
  --run-id "$RUNID" --mode full --dry-run \
  --candidate-workflow-run-id local \
  --candidate-commit "$COMMIT" \
  --provenance-digest "$PROVENANCE_DIGEST" \
  --expected-ipns-predecessor-cid "$IPNS_PREDECESSOR_CID" \
  --expected-ipns-predecessor-sequence "$IPNS_PREDECESSOR_SEQUENCE"
```

Step 5 always uploads nothing. Run it only from the candidate `COMMIT`; the helper enforces a
clean committed publication-code closure while allowing generated run evidence outside that
closure. It records a `PREPARED_LOCAL`/`BUILT` attempt and writes
`data/artifacts/publish/lake/manifests/$RUNID.publication-request.json` for review.

## The publish gate

The old committed boolean gate is retired and preserved only as historical evidence in
`artifacts/publish-gate.json`. It is not authority. The operator signs the exact request
outside this repository with an Ed25519 key; the signature binds county, run, root CID,
manifest and provenance digests, publication mode, candidate workflow identity, bucket,
existing IPNS name/key, exact predecessor CID/sequence, the strict Pinata destination and pin
names, actions, expiry and nonce. The private key and signed approval must remain outside the
repository.

A live invocation requires `SECONDARY_PIN_SERVICE_URL` to be exactly
`https://api.pinata.cloud/psa` (no trailing slash or normalized variant) and a scoped Pinata JWT
in `SECONDARY_PIN_SERVICE_TOKEN`. The exact provider, origin, path and deterministic root and
manifest pin names are signed. Runtime configuration is compared before the token, capability
file or network client is touched. Both pins must reach `pinned` before gateway verification.

```bash
REQUEST="$PWD/data/artifacts/publish/lake/manifests/$RUNID.publication-request.json"
COMMIT="$(jq -er '.target.candidateCommit' "$REQUEST")"
PROVENANCE_DIGEST="$(jq -er '.target.provenanceDigest' "$REQUEST")"
export SECONDARY_PIN_SERVICE_URL=https://api.pinata.cloud/psa
node scripts/lake/publish-approve.mjs \
  --request "$REQUEST" \
  --private-key /secure/operator/lake-publication-ed25519.pem \
  --output /secure/operator/"$RUNID".approval.json \
  --approver "<operator identity>" \
  --expires-at "<short-lived ISO-8601 timestamp>"

node --max-old-space-size=6144 scripts/lake/publish-run.mjs \
  --run-id "$RUNID" --mode full \
  --candidate-workflow-run-id local \
  --candidate-commit "$COMMIT" \
  --provenance-digest "$PROVENANCE_DIGEST" \
  --expected-ipns-predecessor-cid \
  "$(jq -er '.target.ipnsPredecessor.cid' "$REQUEST")" \
  --expected-ipns-predecessor-sequence \
  "$(jq -er '.target.ipnsPredecessor.sequence' "$REQUEST")" \
  --approve /secure/operator/"$RUNID".approval.json \
  --approval-public-key /secure/operator/lake-publication-ed25519.pub.pem

node scripts/lake/publish-approve.mjs --status
```

`artifacts/publication-attempts.json` is the transactional receipt ledger. A retry resumes
the same exact attempt; it does not create a second writer. The publisher records both CAR
uploads, reconciles both independent pins, verifies every manifest artifact through two
independent gateways, records history, repoints the pre-existing IPNS name last, reads the
exact key/CID back, consumes the nonce and then finalizes. Before any mutation, the live
IPNS value must equal the newest immutable local history predecessor. Null or mismatched
readback, an unknown predecessor, expiry, target drift and replay all fail closed.

## Two-phase GitHub Actions release

1. Confirm `IPNS_PREDECESSOR_RECEIPT_JSON_B64` still represents the reviewed live Filebase
   name, including its exact CID and integer sequence. Then run the scheduled workflow or
   dispatch it with `publish=false`. It builds and uploads
   `lake-run-<runId>` as a `PREPARED_LOCAL` artifact.
2. Review its coverage, CARs, manifest, request, ledger, and full-history evidence. Sign
   only its exact publication request outside the repository.
3. Dispatch again with `publish=true`, the exact `publication_run_id`, and the first
   workflow's `candidate_workflow_run_id`. This dispatch downloads those bytes; it skips
   acquisition, consolidation, and candidate assembly.

After a successful publish, RAG promotion and hosted runtime deployment remain separate
reviewed changes. The workflow does not silently rewrite `packages/rag/corpus-source.json`
or claim that a generated index was deployed.

Promote only the explicit finalized run/root after its downloaded `latest.json`, manifest,
verification receipt, publication ledger and run directory are present in this checkout:

```bash
pnpm --filter @oracle-lake/rag promote:published -- \
  --run-id "$RUNID" --root-cid "$ROOT"
pnpm --filter @oracle-lake/rag inspect
pnpm --filter @oracle-lake/rag eval
```

The promotion command rejects identity drift, incomplete two-gateway verification, a ledger
that is not exactly `FINALIZED`, or any local artifact whose bytes differ from the finalized
manifest. Only after validation does it write the promotion receipt, switch the corpus
source and rebuild the deterministic index. Review those three files before deploying the
runtime.

## An incremental run

The county permit layer can be windowed on `Permit_LastModDate` only when a verified
immutable merge base is supplied by the durable coordinator:

```bash
node scripts/lake/fetch-sources.mjs --only permits --since 2026-09-08
```

then repeat steps 3 to 5 with `--mode incremental`. A disposable runner never guesses a
merge base from a cache; the checked-in workflow performs a bounded full county-source
acquisition. Run history records property row deltas and per-table count deltas. When the
mutable local hash cache is absent, publication reconstructs property hashes from the
immutable predecessor Parquet and fails closed if it cannot.

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
