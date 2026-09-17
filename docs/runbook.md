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
names, the delivered archive CAR's exact upload bytes/CID/key and secondary pin name,
actions, expiry and nonce. The private key and signed approval must remain outside the
repository.

A live invocation requires `SECONDARY_PIN_SERVICE_URL` to be exactly
`https://api.pinata.cloud/psa` (no trailing slash or normalized variant) and a scoped Pinata JWT
in `SECONDARY_PIN_SERVICE_TOKEN`. The exact provider, origin, path and deterministic root and
manifest/archive pin names are signed. Runtime configuration is compared before the token, capability
file or network client is touched. All three Pinata pins must reach `pinned` before gateway verification.

Credential creation does not prove plan capability. On 2026-09-16 the configured
scoped JWT's read-only PSA list request returned HTTP 403, `PAID_FEATURE_ONLY`,
with "You must be on a paid plan to pin by CID". The approved Free setup cannot
execute this route. Do not upgrade, change providers, omit artifacts, or request
a signature for a non-executable target. Obtain a separately approved independent
provider route first; then prepare its exact publication request. Uploading a CAR
as ordinary file bytes does not independently pin or serve the CIDs inside it.

### Explicit Lighthouse preparation

Select `--secondary-provider lighthouse` on both preparation and any separately
approved live invocation. The default remains Pinata; a Pinata signature cannot
authorize Lighthouse. The signed Lighthouse destination is strictly
`https://api.lighthouse.storage`, origin `https://api.lighthouse.storage`, path
`/api/lighthouse/pin`; its request uses `{cid, fileName}`, not PSA `{cid, name}`.
Use only the owner-provided `IPFS_API_KEY` in an ignored/private env file. The
optional `LIGHTHOUSE_PIN_SERVICE_URL` must equal that exact base, before and after
env-file loading. Never substitute a Pinata JWT or an ordinary CAR-file upload.

The owner-created Lite subscription currently shows 500 GB at $12/month, next
billing 2026-10-16. Read-only inventory/usage requests passed with zero files and
zero usage. The key's displayed scope is `admin`, not pin/read-only. On 2026-09-17
the owner approved this existing $12/month plan as a specific exception to the
$5/month ceiling, not a blanket budget increase. The cumulative $25 one-time
ceiling and all other constraints remain unchanged. This budget exception does
not authorize live pins, publication, upgrades or billing changes; do not cancel
the owner's subscription.

The narrow adapter records request intent before POST, acceptance separately,
then reconciles the exact CID/name against authenticated paginated inventory and
public unencrypted CID/size metadata. CIDv0 notation is accepted only when it
canonicalizes to the identical CIDv1 DAG; no bytes are re-encoded. Private
attempt/object-specific checkpoints live beside the build manifests, outside
the published data DAG, with mode-0600 atomic replacement. Each new Lighthouse
request has a 20-second abort deadline. Interrupted/accepted requests are reconciled without
blindly repeating POST. File sizes must match expected manifest/archive bytes;
directory metadata size is provider-reported, not falsely equated with the
manifest's raw directory-block size.

Registration is **not** verified independent retention. This branch does not
invent PSA `pinned` status, and both publisher and ledger reject promotion on
registration-only evidence. Live requests are recorded below. Real
provider retention acknowledgement remains to be established under a separate
exact-target signature; the plan-specific budget exception is recorded above.
Two gateways alone can
still retrieve blocks from Filebase. Do not demand sealed Filecoin deals or add
a new certification workflow merely to replace the provider's acknowledgement.

### Replication-only human approval

For a separately approved upload-and-pin request, add
`--execution-scope replication-only --secondary-provider lighthouse` to both
the existing preparation and live commands. Keep `--dry-run` during preparation;
local code approval is not live execution authority. The unsigned request is
`<run-id>.replication-only.publication-request.json`; do not substitute the older
all-action request. The owner explicitly removed our added personal-signing step
on 2026-09-17 and approved continuing the existing limited run. Record that actual
consent in a private handoff, then use the existing approval utility without keys:

```bash
node scripts/lake/publish-approve.mjs --record-approval \
  --request <run-id>.replication-only.publication-request.json \
  --output <external-owner-approval.json> --approver rarcifa \
  --approval-source owner-conversation --expires-at <approved-window-end>
```

This records consent already given by the human; an agent must not invent consent
or treat credentials, a name or a boolean as new owner approval. The versioned
plain manifest contains `approved: true`, `approvedBy`, `approvedAt`, expiry,
nonce and the exact target. It is not cryptographic authentication and records
no key identity. Live execution supplies `--approve` without a publication public
key. Candidate/provenance, artifact bytes/digests, provider/destination and
predecessor checks still run. Existing recovery requires its trusted public key
for verification only, not another signing action. Keep all evidence external;
the approval utility refuses overwrite. No new workflow or certificate is introduced.

The approved actions are exactly `upload-root-car`, `upload-manifest-car`, and
`pin-secondary-copy`. The first action includes the bound archive CAR upload;
the third includes the root, manifest and archive pin requests. Omitting the
scope preserves existing full-publication targets and signatures without adding
a parsing default. Plain human approval is supported only for replication-only;
legacy signed approvals remain valid and invalid signatures never fall back.
Neither limited approval can authorize the full scope.

After the three byte-verified immutable uploads and actual provider evidence,
the ledger stops at `REPLICATION_REQUESTS_RECORDED`, a separate terminal branch
after `MANIFEST_UPLOAD_RECORDED`. Lighthouse evidence distinguishes acknowledged
requests, inventory/metadata registrations and interrupted requests whose outcome
is uncertain. Bounded polling may finish with pending evidence; an interrupted
POST is never described as accepted and is never blindly repeated. Private
checkpoints retain redacted acknowledgements; the ledger retains their digests,
not their response bodies. HTTP acceptance or registration is not retention.

This result explicitly has `retentionVerified: false` and `promotionHeld: true`.
Ledger validation, transitions and dispatch forbid two-gateway verification,
successful run history, IPNS mutation, full-success approval consumption and
`FINALIZED` under that scope. Latest, row hashes and the RAG data selector stay
unchanged. The nonce remains reserved to the same attempt. A terminal retry
verifies the original approval evidence locally, including after expiry, then returns
the recorded evidence with zero repeated remote effects. This is not the
assignment's completed public-publication proof. Provider retention evidence
and a separate exact full-publication go/signature are still required for
promotion; never widen the limited approval to make that happen. Official
coverage-only cryptographic signing remains untouched.

### Primary CAR readback repair

Earlier failure/diagnosis, 2026-09-17: the signed `9218ffc` GET-first invocation failed
with HTTP 500 before body, with zero PUTs or Lighthouse requests. A bounded
read-only comparison returned 500 both with and without the optional SDK
checksum header. Do not change checksum settings or switch the IPFS `.com`
endpoint to the object-storage `.io` endpoint to address this failure; see
[Filebase's endpoint distinction](https://filebase.com/docs/ipfs/overview).

The exact root is retrievable as a complete public CAR export. All 1,352
expected blocks match, but export ordering changes the CAR transport digest.
The repaired helper's complete streamed readback succeeded in 17.5 seconds;
[the diagnostic](../artifacts/filebase-readback-20260917T110926Z.json) is not a
successful-publication receipt. No ledger, pins, IPNS, successful history or
dataset selection was advanced.

For a newly reviewed request, `--primary-readback imported-dag` adds the
explicit signed `primaryReadback` field. Authenticated HEAD must bind the
immutable key's size, import metadata and CID to the frozen target, then the
fixed Filebase gateway's CAR export must pass complete root/block-set equality,
block bytes/hashes and reachability. Reject duplicate, missing, extra,
substituted and truncated blocks. Verification allocates only a bounded block,
not another whole-object buffer. Only definite HEAD 404 permits creation after
the unchanged fresh authorization/predecessor guard; conditional PUT has one
SDK attempt. An uncertain create exits; the next authorized invocation must
HEAD and completely reconcile, never blindly PUT again.

Receipts label `readback.representation: imported-dag` and
`transportVerified: false`: the original signed upload sizes/digests are not
claimed as downloaded original-encoding proof. The separately addressed
archive-file artifact remains the original snapshot CAR bytes and must pass
its manifest digest/size checks during final publication. Provider export is
not two-independent-gateway proof or independent retention. Omitted mode
retains the legacy GET contract below. Never run changed code under the old
signature; use the existing human approval helper for the new exact request.
Arceus routed this through Oracle, engineering/use-oracle and the existing
county-open-data-publish neighbour, without a new workflow or vendor.

The owner-authorized `e91a76d` invocation began at 12:10:50 UTC on 2026-09-17.
The existing root reconciled with 1,352 verified blocks; archive creation/readback
verified 1,310 blocks, and manifest creation/readback verified its single block.
All receipts retain the original outbound digests separately from observed CAR
export digests. Lighthouse acknowledged root, manifest and archive requests with
HTTP 200. Root and manifest registrations reconciled, but archive metadata
comparison failed; the process exited 1 and the ledger remains
`MANIFEST_UPLOAD_RECORDED`, revision 21. No second invocation was made.

Read-only postflight at 12:21:23 UTC found all three exact CIDs and names in the
account inventory, with public metadata. Lighthouse reports 341,078,214 bytes
for the archive, exactly the sum of its 1,310 frozen DAG blocks; the separately
manifested snapshot file is 341,012,575 bytes. The provider's DAG-block size and
the artifact's logical file size must remain distinct. Do not change the
manifest, fabricate a passed byte gate, hand-advance the ledger or rerun the
failed attempt blindly. Any adapter correction must preserve exact artifact
size/digest checks, retention and independent gateway gates; changed live code
requires its own matching authorization.

The [unchanged manifest](../artifacts/manifest-20260916T181000Z.json) and
[sanitized execution evidence](../artifacts/filebase-replication-20260917T122123Z.json)
are delivered in the repository. IPNS remains sequence 13 at the predecessor;
successful history, latest, row hashes and the RAG selector remain unchanged.
No cloud, billing, push or PR changes occurred. These observations establish
Filebase repair and accepted replication requests, not completed publication
or independently retained bytes.

The approved local size correction now derives unique DAG-block bytes from each
complete frozen root/manifest/archive CAR. The helper requires the exact single
root, verifies block hashes and reachability, counts shared CIDs once, excludes
CAR framing and rejects unreachable extras. Lighthouse's explicit
`expectedDagBytes` checks the observed provider representation for these imports:
inventory and public metadata must agree with each other and with the derived
value. Zero is checked explicitly; invalid or simultaneous legacy/DAG contracts
fail before any network call. Legacy `expectedBytes` behavior remains strict.

The [recorded-data offline replay](../artifacts/lighthouse-dag-size-replay-20260917T123212Z.json)
matches root 340,959,826, raw manifest 11,417 and archive DAG 341,078,214 bytes.
It made zero network calls, uploads, pins or ledger writes. The separately
manifested archive file remains 341,012,575 bytes with its original digest.
No target/receipt format, provider endpoint, retry bound, creation guard or
retention/promotion requirement changed. The failed `e91a76d` checkout and
accepted-request checkpoints remain intact. A later authorized changed-candidate
execution must reconcile those same CID/name inventory entries rather than
repeat pin requests; its exact recorded human approval is still required, but
the later replication-only consent route no longer requires signing. This local
fix did not resume the publisher or promote anything.

The 2026-09-17 signed `b3d92c6` attempt and one unchanged resume both ended
with a TLS abort before the first complete CAR readback. Its ledger remains
`AUTHORIZED`: no upload receipt, Lighthouse request, gateway proof, successful
history or IPNS promotion was recorded. Root CAR HEAD metadata reported
341,012,575 bytes and the expected CID; manifest/archive returned 404. Root
LastModified advanced on resume despite the SDK serializing `If-None-Match: *`.
This does not establish provider atomic conditional-write protection. Separate
authenticated S3 CAR Range probes returned HTTP 200 with the full object length;
the bodies were destroyed without full download. They are neither partial-byte
verification nor proof of complete content. The TLS failure's cause remains
undetermined.

The local repair retains the existing publisher and exact byte-bound receipts:

- GET first; fully compare streamed bytes, total size and SHA-256 against the
  frozen CAR. Only definite `NoSuchKey`/404 permits creation. Existing-object
  mismatch, truncation, 403, timeout or ambiguous failure causes zero PUTs.
- A fresh authorization/predecessor guard runs after asynchronous absent-object
  preflight and immediately before PUT. `IfNoneMatch` remains defense-in-depth;
  it is not a vendor-atomicity guarantee. The publisher uses SDK `maxAttempts=1`,
  and the helper refuses creation with retries enabled. A lost acknowledgement
  exits uncertain; a later authorized invocation must reconcile by GET first.
- Each request, including GET headers and its complete body, has a ten-minute
  deadline. Verification retains no second whole-object buffer; incomplete or
  oversized streams are destroyed. Diagnostics expose expected/received byte
  counts and whitelisted error codes, not vendor bodies, messages or secrets.
- No Range reconstruction, sampled-byte receipt, metadata-only acceptance,
  hand-edited ledger advancement or signature reuse against changed runtime.

Real-SDK offline fixtures test serialization, interrupted/oversized/truncated
streams, lost acknowledgements, conflicting existing objects, guarded creation
and zero PUTs on unknown errors. Publisher fixtures additionally expire approval
or change the predecessor during asynchronous GET and prove no creation or pins.
These checks do not prove that the live transport will succeed. Preserve the
blocked signed checkout, approval, ledger and actual remote object. A tested
changed candidate needs its own provenance and matching human go/signature;
do not run it under the `b3d92c6` signature. Dataset capture is not restarted.

A bounded read-only review of the official Pin CID, List Files and File Info
documentation and Go SDK did not establish a documented completed-retention
response contract. The SDK's Pin method returns an HTTP-call error/result, while
its optional inventory `status` string has no defined retained-state semantics
in the reviewed [Pin implementation](https://github.com/lighthouse-web3/lighthouse-go-sdk/blob/main/lighthouse/files/files.go)
and [inventory schema](https://github.com/lighthouse-web3/lighthouse-go-sdk/blob/main/lighthouse/schema/types.go).
Disclose that uncertainty in the separate exact-target
approval request. An approved live request may provide real acknowledgement
evidence; do not claim that offline fixtures establish a retained copy or bypass
the existing retention hold.

Business accounting uses one export-grain rule in plausibility, new history and
the recovered predecessor: a legacy property-associated export counts only
`matchedToParcel`; a modern `accountTableAvailable` export counts its reconciled
`queryableSourceAccounts`. The latter must equal coverage's account-table rows
and the actual Parquet count, with unique non-empty account IDs. A genuinely
truncated table still fails. Never use the table-shrink override to conceal a
grain mismatch, or rewrite original recovery/history bytes to invent prior
publication of unmatched accounts.

The repaired publisher checks all manifest entries, including directories, and the manifest
itself against two independent public gateways. It validates the complete multi-root
snapshot CAR offline and publishes its actual file bytes by a distinct file CID. The
manifest maps every directory root to that delivered CAR; the workflow packet includes
snapshot and transport CARs. Older immutable manifests/receipts remain historical and
are not silently promoted to this stronger proof.

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
readback, an unknown predecessor without a separately verified signed recovery anchor,
expiry, target drift and replay all fail closed. The pointer is checked again immediately
before each upload, new independent pin and promotion. Filebase exposes no atomic
compare-and-swap in this adapter; a fresh comparison narrows the race window, it does not
claim an atomic provider operation. Post-write sequence readback remains mandatory.

## External predecessor recovery

Arceus selected `use-oracle/reference/continuous-ingestion.md`'s
**Cross-environment handoffs** and the trusted human-signature pattern from
`coverage-only-publication.md`. This is not that skill's coverage publisher and
must not create another IPNS name or change the existing open-data pointer.
The owner approved recovering only the externally observed sequence-13 anchor.
No original approval/success/readback receipt is fabricated, and
`artifacts/run-history.json` remains unchanged during recovery.

From the repository root, calculate the publication provenance digest for the
exact committed candidate, then prepare an external private packet:

```bash
node pipeline/scripts/lake/publication-provenance.mjs --candidate-commit <exact-40-character-SHA>
node pipeline/scripts/lake/recover-predecessor.mjs --prepare \
  --input-dir <new-external-private-directory> \
  --candidate-commit <same-exact-SHA> --provenance-digest <reported-sha256-digest> \
  --expected-ipns-name k51qzi5uqu5dgd1ekyyuhwggov571fjxof2p5ef4ke7enlq60k03r47fosb2un \
  --expected-root bafybeieiswif55i4ofj7saucyzhak23uim4shipijfdkvwhfcjrp2zaq7y \
  --expected-sequence 13 \
  --manifest-cid bafkreihujmyavnl3esbsvcfezl35a67lmmfxf3orxhppwjb7ylszidnlpq
```

This bounded read-only preparation verifies original manifest/root/coverage/query
bytes by CID from Filebase and IPFS Lens. It checks the actual redirected hosts,
the producer root's links, file CIDs, content digests and the immutable last-known
successful history. Actual query row/unique-folio/null counts are reconciled with
that producer coverage and bound into the evidence before human signing. This
does not require the legacy predecessor to acquire a newer column schema.
A final authenticated name/root/sequence comparison rejects
drift. Existing files are never overwritten. Its coverage may predate the producer
manifest; preserve those timestamps rather than implying a reconciled historical run.

Only the **human approver** runs the following, using their independently trusted
external Ed25519 key (the kit documents human key generation if none exists).
The agent must not create a keypair and then authorize itself as the owner.

```bash
node pipeline/scripts/lake/recover-predecessor.mjs --sign \
  --input-dir <prepared-private-directory> \
  --private-key <existing-external-Ed25519-private-key.pem> \
  --output <external-recovery-approval.json> \
  --approver rarcifa --expires-at <short-lived-ISO-8601-UTC-time>

node pipeline/scripts/lake/recover-predecessor.mjs --accept \
  --input-dir <prepared-private-directory> \
  --approval <external-recovery-approval.json> \
  --approval-public-key <independently-trusted-external-public-key.pem>
```

Acceptance verifies every frozen byte and the current pointer again, then records
only `recovery-receipt.json`, status `externally_observed_recovered`, beside the
private packet. Same-authorization retries are idempotent; replacement approvals
cannot overwrite that receipt. All original historical receipts remain unknown.
Recovery creates no pins, uploads, IPNS changes, deployments, accounts or charges.
The original history bytes are frozen inside the private handoff. A finalization
retry can preserve that anchor after the real new run is recorded: only the exact
durable succeeded run receipt may be added ahead of the unchanged original entries.
Unrelated growth or modification of older history is rejected. A consumed approval
can verify the same attempt's local finalization; it is never reauthorized for
another attempt or another remote mutation.

A later publisher invocation may use
`--predecessor-recovery <external-recovery-receipt.json>` and
`--recovery-public-key <trusted-public-key.pem>`. It re-verifies the signature and
packet and binds the receipt digest into the new exact publication target.
The recovered immutable query table, not the old mutable row-hash cache, is the
delta baseline. The recovery approval must still be active before new remote effects, and the later
publication still requires its own exact-byte signature, secondary-provider
credentials and all existing verification gates. Nothing in recovery waives
dataset eligibility, source limitations, cumulative budgets or the final demo.
Only the identical already-consumed attempt may finish local receipt reconciliation
after expiry, using its original valid authorization window and current target-pointer
readback. This does not reauthorize uploads, pin creation or IPNS writes.

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
