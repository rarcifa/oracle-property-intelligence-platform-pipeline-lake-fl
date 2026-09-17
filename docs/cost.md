# Cost model — portable by default, owner-funded operations by choice

The assignment requires that Oracle not carry ongoing infrastructure cost by default. The
architecture meets that goal by making immutable files, not a hosted database or API, the
source of truth. It does **not** claim that storage, scheduled compute, or an optional demo
runtime is free forever.

## Default read path

Published data is identified by immutable IPFS CIDs. The repaired publisher prepares a
CID-addressed multi-root CAR containing every listed directory DAG. The chosen
source-only preview's logical `snapshot.car` is public by CID and its complete
341,012,658 bytes match the manifest digest through Filebase and Pinata gateways;
see the [handoff](submission-handoff-20260917.md). The later normal publication
of `20260916T181000Z` established independent Lighthouse retention through
authenticated exact-CID inventory/metadata, public manifest bytes and complete
CAR bytes with all manifested roots verified. Its ledger is `FINALIZED`; the
newer incremental archive remains queued at Lighthouse and is not yet a
finalized publication. Neither result promises indefinite retention if both
providers stop serving the data. DuckDB reads the roughly 20 MB property Parquet with HTTP range requests, so a browser,
agent, or MCP process can query it without an Oracle-operated database. A vendor gateway is
a locator, never the identity.

| Component    | Default operator                                             | Oracle fixed cost |
| ------------ | ------------------------------------------------------------ | ----------------: |
| Query tables | Consumer-side DuckDB from immutable CIDs                     |              none |
| UI           | Static files or the consumer's checkout                      |              none |
| MCP          | Consumer-run stateless process over the published artifacts  |              none |
| Ingestion    | On-demand laptop, sponsored CI, or explicitly approved Batch | none between runs |
| Pinning      | Release owner on two independent providers                   |    plan-dependent |
| Hosted demo  | Optional owner deployment, bounded by reserved concurrency   |   usage-dependent |

IPFS content is not magically retained. A CID proves identity, while pins and CAR copies
provide availability. A new release therefore requires both Filebase and a second
non-Filebase pinning provider before it can be verified and pointed to by IPNS. If every
pin disappears, a third party can restore the exact root from the CAR, but the repository
does not promise that unpinned blocks remain retrievable.

## Measured fast path

The bulk county sources and DuckDB consolidation are inexpensive:

| Stage                                                    | Measured               |
| -------------------------------------------------------- | ---------------------- |
| DOR NAL + SDF + TPP download                             | 42 s                   |
| GIO centroids, 210,935 rows                              | ~10 s at concurrency 4 |
| CD Plus permits, 17,915 features                         | 6.5 s                  |
| Seed build, 215,806 rows                                 | 7.4 s                  |
| Query-table consolidation in DuckDB                      | 2.2 s                  |
| Publish-set build (22 shards, samples, schema, coverage) | 15 s                   |

Those timings do not include the slow source. Clermont eTRAKiT is a polite, bounded HTML
harvest. The measured year-26 capture used 4,622 requests, about 0.6 hours, and roughly
3.6 GB of raw HTML. The known permit-year 15–26 history is estimated at about 66,000
requests, 8–9 hours, and 50 GB before retry headroom in the early estimate. Those are
historical estimates, not current ETA: all twelve partitions are now locally captured,
with 58,495 retained Clermont permits. The durable coordinator evaluates a
conservative upper bound first and pauses for explicit approval when the job exceeds 48
hours or the request's cost ceiling. Execution then persists a single hard deadline across
resumes, rejects clocks behind that budget, and stops before another partition when the
approved duration or cost-derived runtime window is exhausted.

Scheduled clean runners do not redo that harvest and do not substitute an empty file. They
restore one exact content-addressed last-good baseline through a read-only OIDC role, verify
every partition and digest, and fail before consolidation if the baseline is missing,
stale, or incompatible. Storage, egress, and runner minutes belong to the account chosen by
the release owner and must be estimated before enabling the schedule. The Clermont request
fixes a 150 GiB retained-object ceiling (about US$4.50/month at the deliberately conservative
US$0.03/GiB model); remote promotion lists existing content-addressed objects and fails before
upload if the candidate would exceed it. The preflight counts current and noncurrent object
versions across the whole Clermont prefix and reserves space for the promotion intent and
last-good pointer. A failed candidate keeps an exclusive six-hour intent lease; the same
candidate can resume immediately, while a different candidate can take over only after expiry
through an ETag-fenced write. The CDK stack sends its S3 storage alarm to the approved SNS email
and gives the branch-bound workflow role permission to notify that same topic after an
ingestion failure. It does not silently delete old certified evidence.

## Optional costs deliberately outside the default path

The existing US$25 one-time and US$5/month recurring-storage ceilings are cumulative,
not renewed on each repair. Approval-consumption records and unactivated cost-allocation
tags do not establish actual spend. Before upload/deploy, reconcile retained current and
noncurrent storage, remaining allowance and the approved estimate. Measured frozen baseline
artifacts total 12,240,346,190 bytes: about US$0.34/month at the conservative US$0.03/GiB
model for one copy, not a bill or proof of remote promotion. Pinata Free quota and existing
usage must fit the dataset plus the delivered CAR before pinning; no Pinata paid
upgrade is approved. The actual bounded CD Plus refresh took 2.883 seconds for 1,118 features,
independent of the completed full Clermont harvest.

On 2026-09-17 the owner approved the already-established $12/month Lighthouse
Lite subscription as a specific exception to the $5/month recurring-storage
ceiling. This is owner-funded retention, not a free plan or a default cost to
Oracle. The cumulative $25 one-time ceiling and every other approved constraint
remain unchanged; no general paid-tier increase, upload, pin or billing mutation
is implied. Lighthouse's current [retention contract](https://docs.lighthouse.storage/intro)
depends on an active plan, so the demo must disclose who continues funding it.

- The hosted Lambda is a demo convenience, not the data source. Reserved concurrency caps
  concurrent requests, not cumulative charges. Per-caller request/model limits and
  the approved cumulative allowance remain necessary; concurrency is not a dollar cap.
- Natural-language chat uses an OpenAI model only when the owner configures a Secrets
  Manager key. REST, MCP, SQL, RAG retrieval, and the UI remain usable without it.
- BBB enrichment is policy/API-gated under the Soofi kit. The default route returned 403;
  one prohibited browser-fingerprint spoof returned 200, but no data was retained and no
  approved official-API harvest was run. The affected values stay null with that reason.
- PagerDuty, a shared dashboard, the durable Clermont baseline bucket, and a second pinning
  provider are owner control-plane choices. Their repository contracts are implemented;
  no account or cost is silently created.
