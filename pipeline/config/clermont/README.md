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

Prepare a scope-bound request and estimate without performing acquisition:

```bash
npm run clermont:prepare -- \
  --repo-root .. \
  --template <operator-approved-template.json> \
  --run-store <durable-run-store> \
  --baseline-store data/baselines/lake/clermont \
  --now <ISO-8601>
```

Preparation hashes the exact source, configuration, schema, benchmark, and baseline scope.
It pauses in `WAITING_HUMAN` when the conservative estimate exceeds 48 hours or the cost
ceiling. Approval must be unexpired and bound to that estimate digest.

The production sequence is `clermont:run`, `clermont:status`, `clermont:certify`, then
`clermont:promote`. `clermont:run` is inert unless the operator supplies `--live-fetch`.
Each run pass leases and seals one year at a time; `--prune-loose-after-seal` removes only
the named loose raw/extracted/status directories after all sealed archive digests and record
counts have been read back successfully.

Local promotion creates a content-addressed baseline using hard links where possible and a
separate `promotion/consumption-request.json` bound to the promoted baseline, export,
metadata, signatures, and all 12 years. Remote backup/promotion is a separate explicit step:

```bash
npm run clermont:sync-promote -- \
  --run-store <durable-run-store> \
  --baseline-store data/baselines/lake/clermont \
  --run-id <run-id> \
  --bucket <private-versioned-bucket> \
  --prefix clermont \
  --region <aws-region> \
  --now <ISO-8601> \
  --live-sync
```

The S3 step reconciles immutable objects by byte count and SHA-256, performs a complete
streamed GET readback, and advances `last-good.json` with `If-Match`/`If-None-Match` before
reading the pointer back. It does not delete remote objects. This is baseline storage, not
public dataset publication.

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

Incremental refresh reuses terminal closed partitions before 2025, revisits the stable IDs
of open records in older partitions, and fully refreshes 2025–2026. A full refresh enumerates
all 12 partitions. These boundaries are fixed to this assignment snapshot; extending the
history requires a new schema version and reviewed request.
