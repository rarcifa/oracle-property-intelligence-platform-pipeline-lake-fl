# Cost model — portable by default, owner-funded operations by choice

The assignment requires that Oracle not carry ongoing infrastructure cost by default. The
architecture meets that goal by making immutable files, not a hosted database or API, the
source of truth. It does **not** claim that storage, scheduled compute, or an optional demo
runtime is free forever.

## Default read path

Published data is identified by immutable IPFS CIDs and can be imported from the committed
CAR. DuckDB reads the roughly 20 MB property Parquet with HTTP range requests, so a browser,
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
requests, 8–9 hours, and 50 GB before retry headroom. The durable coordinator evaluates a
conservative upper bound first and pauses for explicit approval when the job exceeds 48
hours or the request's cost ceiling.

Scheduled clean runners do not redo that harvest and do not substitute an empty file. They
restore one exact content-addressed last-good baseline through a read-only OIDC role, verify
every partition and digest, and fail before consolidation if the baseline is missing,
stale, or incompatible. Storage, egress, and runner minutes belong to the account chosen by
the release owner and must be estimated before enabling the schedule.

## Optional costs deliberately outside the default path

- The hosted Lambda is a demo convenience, not the data source. Reserved concurrency caps
  the request and model-spend blast radius.
- Natural-language chat uses an OpenAI model only when the owner configures a Secrets
  Manager key. REST, MCP, SQL, RAG retrieval, and the UI remain usable without it.
- BBB enrichment requires approved AWS-managed remote browser compute under the Soofi kit.
  It was not run, and the affected values stay null with a source-gating reason.
- PagerDuty, a shared dashboard, the durable Clermont baseline bucket, and a second pinning
  provider are owner control-plane choices. Their repository contracts are implemented;
  no account or cost is silently created.
