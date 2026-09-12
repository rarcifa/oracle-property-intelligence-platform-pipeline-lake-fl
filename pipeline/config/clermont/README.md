# Clermont durable ingestion contract

This directory documents the local control plane for Clermont permit history. It does not
contain a runnable request: a request must bind the exact source, configuration, schema, and
last-good baseline digests created by an operator-approved acquisition.

The source boundary is one partition per permit year from 2015 through 2026. A partition is
terminal only when:

- `enumerated = completed + provenDead + retryablePending`;
- `completed = linked + validUnlinked`;
- no retryable record remains;
- the source was not capped or truncated; and
- raw, extracted, status, stable-ID, and checkpoint evidence reconcile.

`src/batch/clermont-contracts.ts` validates requests, partition handoffs, and certified
baselines. `src/batch/clermont-coordinator.ts` supplies the cost-first state machine,
refresh policy, leases, fencing, heartbeats, cooldowns, retries, and circuit breaker. The
run store persists coordinator revisions and fenced per-year workers. Evidence is sealed as
deterministic gzip NDJSON archives so certification can stream it without retaining loose
raw HTML.

The executor derives lifecycle timestamps from an injected monotonic clock. One single-flight
lease supervisor owns each year from enumeration through harvest, sealing, optional pruning,
and the terminal worker transition. Handoffs and prune receipts record that supervisor's owner,
fencing token, and heartbeat; certification also requires the matching terminal worker
checkpoint. A heartbeat failure aborts the child process and prevents handoff or pruning. The
run-store lock renews its liveness during fenced filesystem work and checks ownership again
before returning.

Prepare a scope-bound request and estimate without performing acquisition:

```bash
npm run clermont:prepare -- \
  --repo-root .. \
  --template <operator-approved-template.json> \
  --run-store <durable-run-store> \
  --baseline-store data/baselines/lake/clermont \
  --now <ISO-8601>
```

Preparation hashes the exact source, Lake seed, transitive parser, dependency lock, runtime
configuration, executable control plane, schema, benchmark, and baseline scope. The non-circular
executor policy is bound as virtual configuration input `input/clermont-executor.json`;
authorization remains canonical request data rather than configuration-signature input. The
template also binds the exact Node version/platform/architecture and private S3 account, region,
bucket, and prefix. Loading a prepared run recomputes its request/provenance digests and rejects
missing, additional, duplicate, or reordered scope paths.
It pauses in `WAITING_HUMAN` when the conservative estimate exceeds 48 hours or the cost
ceiling. Approval must be unexpired and bound to that estimate digest.

Manual cost approval uses two fail-closed preparation passes. First prepare the intended run
with `authorization: null` into a disposable preview store. The command reports
`authorizationScopeSha256`, `provenanceSha256`, and the complete estimate. After review, copy
those exact values into a fresh template authorization together with a unique
`authorizationId`, the same `runId`, explicit `maxExecutionHours`/`maxCostUsd`, approver, and
expiry, then prepare into the durable store. Any source, dependency, executor, destination,
limit, or run change requires another preview and approval. The authorization nonce is consumed
atomically in the run-store-wide ledger and cannot authorize another run. Execution persists a
single monotonic deadline across resumes, aborts an active harvester at that deadline, and stops
before detail harvesting if enumeration exceeds the approved per-year record bound.

The production sequence is `clermont:run`, `clermont:status`, `clermont:certify`, then
`clermont:promote`. `clermont:run` is inert unless the operator supplies `--live-fetch`.
Every `clermont:run` also requires `--failure-notifier-arn` with the exact
`ClermontBaselineStack.FailureNotifierArn` output. Only a durable `FAILED_EXHAUSTED` state
invokes that function; retry/cooldown, cost-gate, and authorization paths do not page.
Each run pass leases and seals one year at a time. The first production capture retains both
sealed and loose evidence for operator comparison. The CLI rejects `--prune-loose-after-seal`;
the internal crash-recovery path remains tested, but production pruning stays disabled until
deletion is chunked and re-fenced throughout its full duration.

Local promotion creates a content-addressed baseline using hard links where possible and a
separate `promotion/consumption-request.json` bound to the promoted baseline, export,
metadata, signatures, and all 12 years. Remote backup/promotion is a separate explicit step:

```bash
npm run clermont:sync-promote -- \
  --repo-root .. \
  --run-store <durable-run-store> \
  --baseline-store data/baselines/lake/clermont \
  --run-id <run-id> \
  --now <ISO-8601> \
  --live-sync
```

The S3 step reconciles immutable objects by byte count and SHA-256, performs a complete
streamed GET readback, and advances `last-good.json` with `If-Match`/`If-None-Match` before
reading the pointer back. It reads the destination only from the prepared request, verifies the
active AWS account through STS, uploads only the certified artifact set with S3 SHA-256 checksum
enforcement, and checks the remote predecessor before any object write. It lists retained
baseline objects and refuses an upload projected to exceed the request's fixed 150 GiB ceiling;
the CDK stack independently alarms that ceiling to its required SNS email subscription. Confirm
the AWS subscription email after deploying the stack, and set repository variable
`CLERMONT_ALERT_TOPIC_ARN` from its `BaselineAlertTopicArn` output. The branch-bound baseline
reader role may publish only to that topic, so failed scheduled ingestion sends an email when
PagerDuty is unavailable. That email is an operator notification, not an on-call page. A real
page additionally requires one exact Secrets Manager routing-key ARN passed as CDK context
`pagerDutySecretArn` and repository variable `CLERMONT_FAILURE_NOTIFIER_ARN` set from the stack
output. GitHub can invoke that production-gated notifier but cannot read the secret. Local and
remote promotion can resume after their pointer CAS without rewriting an already-applied
pointer. It does not delete remote objects. This is baseline storage, not public dataset
publication.

Materialize only from the digest-bound consumption request:

```bash
npm run clermont:materialize -- \
  --consumption-request <durable-run-store>/runs/<run-id>/promotion/consumption-request.json \
  --baseline-store data/baselines/lake/clermont \
  --output-root .. \
  --now <ISO-8601>
```

This command validates both `clermont-permits.csv` and `clermont-permits.meta.json`, then
replaces the output pair with rollback protection. It fails before replacement when the
pointer, baseline, signatures, freshness, artifacts, yearly coverage, or row reconciliation
disagree. A scheduled runner must never create an empty Clermont CSV as a fallback.

Incremental refresh reuses terminal closed partitions before 2025 only when they have no open
records. Any older partition containing an open record is re-enumerated and replaced as a full
year, so already-closed records cannot disappear from the next baseline; 2025–2026 are also fully
refreshed. A full refresh enumerates all 12 partitions. These boundaries are fixed to this
assignment snapshot; extending the history requires a new schema version and reviewed request.
