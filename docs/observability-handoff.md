# Observability and on-call handoff

This document separates what is implemented in code from configuration that requires an
owner account. No dashboard, PagerDuty service, subscription, secret, or incident was
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
`OK` to one SNS topic so every configured channel receives the trigger and resolution.
Logs retain 90 days. Reserved concurrency is 25 to bound account and model spend.

There is no DLQ for the runtime because it has no asynchronous queue: it is a synchronous,
read-only HTTP surface. The scheduled workflow and AWS Batch jobs instead have terminal
failure paging. Adding a queue later requires a DLQ, an age/rate alarm, and a replay
runbook before deployment.

## Ingestion signals and durable evidence

The scheduled workflow exposes its mode, run ID, coverage, candidate manifest, CARs,
publication request, attempt ledger, and failure URL as workflow logs/artifacts. Clermont
partition handoffs additionally carry enumerated/completed/dead/pending counts, linked and
valid-unlinked counts, contractor/license/open counts, signatures, artifact digests,
leases, fencing tokens, checkpoints, and the conservative cost estimate.

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

Lexicon/dashboard creation is an external control-plane action. The owner should map the
metric names above without renaming them, attach the dashboard URL to this file, and record
the deployment/environment and creation timestamp. Until that receipt exists, repository
documentation must say the metrics are emitted and alarms are declared, not that a shared
dashboard is live.

## PagerDuty owner checklist

1. Create or select the production service and CloudWatch integration.
2. Store the direct Events API routing key in `oracle-lake/pagerduty-routing-key`; do not
   put the value in Lambda configuration.
3. Configure `ORACLE_ALERT_ENVIRONMENT=production`,
   `ORACLE_PAGERDUTY_SECRET_NAME`, `ORACLE_PAGERDUTY_CLOUDWATCH_URL`, and an optional alert
   email for the runtime stack.
4. Configure the repository's `PAGERDUTY_ROUTING_KEY` secret for scheduled ingestion
   failure events.
5. Trigger one approved non-production test incident, verify SNS/workflow delivery and
   deduplication, then resolve it and attach the incident receipt here.

The production guard is deliberate: non-production deployment cannot wake on-call even if
a routing key happens to exist. An unconfigured channel is reported as `none` by the
`AlertingConfigured` stack output and is an operational blocker, not a simulated pass.
