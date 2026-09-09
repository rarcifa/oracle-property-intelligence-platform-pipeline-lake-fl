# Cost model — why Oracle carries no ongoing infrastructure cost

The assignment requires that Oracle not carry ongoing infrastructure cost **by default**.
That is a claim about the read path, and it holds here because the read path has no server
in it at all.

## The read path

Published data lives on IPFS as immutable CIDs. A consumer resolves a CID through any
public gateway, or through their own IPFS node, and gets the bytes. The query surface is a
20 MB Parquet file that DuckDB reads with HTTP range requests, so a browser can answer
"which properties within five miles have roofs older than fifteen years" by fetching a few
kilobytes of the relevant column chunks — no database, no API server, no compute owned by
Oracle.

| Component | Who runs it | Ongoing cost to Oracle |
|---|---|---|
| Published dataset | Public IPFS | none |
| Pinning | Filebase free plan | none at this volume |
| Query engine | DuckDB in the consumer's browser or process | none |
| MCP server | Whoever wants one; it is stateless and reads the public CIDs | none |
| Ingestion | A laptop or a scheduled runner, minutes per run | none between runs |

Delete every account involved and the dataset still resolves: `artifacts/manifest-<run>.json`
lists each artifact's CID, byte size and SHA-256, and the CAR file rebuilds the whole DAG on
any IPFS node without re-encoding it.

## What ingestion actually costs

The full county acquires in well under a minute of network time and consolidates in about
two seconds. There is no scraping fleet because there is nothing to scrape: every source is
a bulk download or a bounded Esri page walk.

| Stage | Measured |
|---|---|
| DOR NAL + SDF + TPP download | 42 s |
| GIO centroids, 210,935 rows | ~10 s at concurrency 4 |
| CD Plus permits, 17,915 features | 6.5 s |
| Seed build, 215,806 rows | 7.4 s |
| Query-table consolidation in DuckDB | 2.2 s |
| Publish-set build (22 shards, samples, schema, coverage) | 15 s |

Ingestion is therefore free on any machine that already exists, and an incremental refresh
is cheaper still: the permit layer is windowed on `Permit_LastModDate`, so a daily run
fetches only what moved.

## The one real limit

The Filebase free plan allows a single IPNS name, which is why this county publishes one run
root under one name rather than the kit's three per-dataset labels. That is a deviation, not
a cost: CIDs are the identity, and every run records its own.

## What would cost money, and is therefore not in the default path

- A hosted runtime for the demo. It is one process behind one URL and is a demonstration
  convenience, not part of the data path.
- BBB enrichment, which the kit requires to run on AWS-managed remote compute. It is not
  run, and the affected columns are published null with the reason attached.
