# Observability and on-call handoff

This document separates what is implemented in code from configuration that requires an
owner account. The Clermont baseline stack declares an SNS email subscription and storage
alarm, but the recipient must confirm the subscription after deployment. CDK declares the
repository dashboard; no external dashboard, PagerDuty service, secret, or incident was
created during the local repair.

## Runtime signals

The Lambda emits structured JSON through Powertools Logger, traces requests and dataset
startup/refresh with active X-Ray, and publishes these `OracleLake/runtime` metrics:

| Metric                 | Unit         | Meaning                                                        |
| ---------------------- | ------------ | -------------------------------------------------------------- |
| `RequestsServed`       | count        | Completed public requests                                      |
| `RequestsFailed`       | count        | Responses at or above HTTP 500 and unhandled request failures  |
| `RequestDuration`      | milliseconds | End-to-end handler duration                                    |
| `ColdStart`            | count        | New Lambda execution environments                              |
| `DatasetOpenMs`        | milliseconds | Immutable Parquet open/materialization time                    |
| `PointerResolveMs`     | milliseconds | IPNS resolution time during dataset startup                    |
| `DatasetUpgraded`      | count        | Successful move to a newly resolved immutable root             |
| `PointerRefreshFailed` | count        | Background IPNS refresh failures while prior data stays served |
| `DatasetUnavailable`   | count        | No verified dataset could be opened                            |

CloudWatch alarms cover Lambda errors, throttles, dataset unavailability, and three
consecutive five-minute pointer-refresh failures. Each alarm publishes both `ALARM` and
`OK` to one SNS topic. A typed, secret-backed subscriber translates those state changes to
PagerDuty `trigger` and `resolve` events using the same stable alarm dedup key; no
credential-bearing integration URL is stored in an environment variable. Logs retain 90
days. Reserved concurrency is 25 to bound account and model spend.

There is no DLQ for the runtime because it has no asynchronous queue: it is a synchronous,
read-only HTTP surface. The scheduled workflow and AWS Batch jobs have terminal failure
notification paths. Those paths page only after the production PagerDuty service and exact
Secrets Manager ARN are configured; until then they deliver the approved SNS email and the
explicit no-PagerDuty deviation remains open. Adding a queue later requires a DLQ, an age/rate
alarm, and a replay runbook before deployment.

## Ingestion signals and durable evidence

The scheduled workflow exposes its mode, run ID, coverage, candidate manifest, CARs,
publication request, attempt ledger, and failure URL as workflow logs/artifacts. Clermont
partition handoffs additionally carry enumerated/completed/dead/pending counts, linked and
valid-unlinked counts, contractor/license/open counts, signatures, artifact digests,
leases, fencing tokens, checkpoints, and the conservative cost estimate.

Each AWS Batch worker uses Powertools Logger and Metrics. Every invocation emits one
`StageProcessed` or `StageFailed` count and one `ProcessingDuration` measurement in the
`OracleLake` namespace. The low-cardinality dimensions are `service`, `environment=production`,
and `operation`; the four exact service/operation pairs are:

| Service                            | Operation        |
| ---------------------------------- | ---------------- |
| `county-enrichment-sunbiz`         | `sunbiz`         |
| `county-enrichment-bbb`            | `bbb`            |
| `county-enrichment-reconciliation` | `reconciliation` |
| `county-enrichment-permit`         | `permit`         |

Before a worker touches its source artifacts, the cost gate emits `CostPredicted` as a
unitless USD value with `service=county-enrichment`, matching the stack's `project_name` tag.
Over-ceiling work remains fail-closed after the metric is recorded.

The `OracleLake-county-enrichment-workers` dashboard charts processed, failed, and p95
duration for each worker independently. Metrics are emitted as CloudWatch Embedded Metric
Format through the existing awslogs sink; workers do not receive raw CloudWatch write
permission.

The same branch-bound role used to restore the certified Clermont baseline may publish only
to the baseline stack's alert topic and, when configured, invoke only its failure-notifier
Lambda. Set repository variables `CLERMONT_ALERT_TOPIC_ARN` and
`CLERMONT_FAILURE_NOTIFIER_ARN` from the stack outputs. The notifier is pinned to production
account `122610508924` in `us-east-2` and reads one exact Secrets Manager ARN at runtime; the
routing key never enters GitHub. A failed scheduled run also sends the approved SNS email.
That email is operator notification only: it has no escalation, acknowledgement, or on-call
ownership semantics and must not be described as paging.

When PagerDuty is configured, the workflow's direct notifier invocation supplies a synchronous
accepted receipt while the shared SNS topic supplies email and a retryable notifier delivery.
Both PagerDuty deliveries use the same stable workflow deduplication key, so the SNS copy updates
the same incident rather than creating a second page.

The minimum dashboard should chart, by run and jurisdiction:

- source records acquired and elapsed time;
- properties, permits, linked permits, valid-unlinked permits, and contractor rows;
- Clermont partitions terminal versus pending, retry rate, permanent-dead rate, and
  last-good age;
- property and per-table count deltas versus the immutable predecessor;
- publication stage, independent-pin state, gateway verification successes, and pointer
  freshness;
- runtime request rate, error rate, p50/p95 duration, dataset-open latency, and pointer
  refresh failures.

[`observability-metrics.json`](observability-metrics.json) is the repository-equivalent
Lexicon registration for every emitted Powertools metric. CDK creates the
`OracleLake-runtime-observability` and `OracleLake-county-enrichment-workers` dashboards from
the same exact names, including notifier and worker processed/failed/duration signals.
Synchronizing that registry to the external Lexicon and Main Dashboard remains an owner
control-plane action; record the external PR and dashboard URL here when it is approved. The
local registration and synthesized dashboards are complete, but neither is represented as an
already-created external resource.

## PagerDuty owner checklist

1. Create or select the production service and an Events API v2 integration.
2. Store `{"routing_key":"<Events API v2 integration key>"}` in the production secret and
   record its complete Secrets Manager ARN. JSON that omits `routing_key` fails closed.
3. Configure `ORACLE_ALERT_ENVIRONMENT=production`, the complete
   `ORACLE_PAGERDUTY_SECRET_ARN`, and an optional alert email. The runtime app and stack both
   reject any account other than `122610508924` or region other than `us-east-2`.
4. Redeploy `ClermontBaselineStack` with the exact secret ARN as CDK context
   `pagerDutySecretArn`, then configure repository variable `CLERMONT_FAILURE_NOTIFIER_ARN`
   from the output. Never create a repository routing-key secret. Until then, keep the
   PagerDuty deviation explicit even if SNS email is live.
5. Pass `--failure-notifier-arn <FailureNotifierArn>` to each `clermont:run`. The CLI invokes
   it only after durable `FAILED_EXHAUSTED`, uses a stable run dedup key, captures the returned
   PagerDuty `dedup_key`, and rethrows the original acquisition error. Cooldowns, retries,
   cost pauses, and authorization rejections do not page.
   Under the approved SNS-only deviation, pass exactly one
   `--failure-topic-arn <BaselineAlertTopicArn>` instead; the CLI validates the production
   account/region, requires a returned SNS `MessageId`, and preserves the original acquisition
   error. The CLI durably records armed/pending/delivered state, closes the terminal-transition
   crash window, applies bounded transport retries, resumes pending delivery on a later operator
   rerun, and suppresses calls after acceptance.
6. Trigger one approved test incident, verify SNS/workflow delivery and alarm
   `ALARM -> trigger` / `OK -> resolve`, then attach the incident receipt here.

The production guard is deliberate: non-production deployment cannot wake on-call even if
a routing key happens to exist. An unconfigured channel is reported as `none` by the
`AlertingConfigured` stack output and is an operational blocker, not a simulated pass.
