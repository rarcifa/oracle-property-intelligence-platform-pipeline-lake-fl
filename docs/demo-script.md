# Demo script — Lake County, FL

Follows the assignment's demo transcript beat for beat. Every number below comes from a
query against the published data; none are typed by hand.

## 1. The pipeline run summary

Open the run panel in the UI, or:

```bash
jq . artifacts/latest.json
jq '.runs[0] | {runId, mode, sources, tables, status, verifiedGateways}' artifacts/run-history.json
```

Shows the run id, every source with its window and record count, the tables loaded with
per-table deltas, and the documented source limitations.

## 2. Uploaded records by source

```bash
ROOT=$(jq -r .rootCid artifacts/latest.json)
curl -sL "https://ipfs.filebase.io/ipfs/$ROOT/coverage.json" | jq '{tables, signals}'
```

Properties, permits and coordinates with their source systems, plus the roofing signals.
Per-row provenance is in the `source_systems` column of the query table.

## 3. The DuckDB query layer

No database server is involved. Point DuckDB at the published Parquet:

```bash
curl -sL "https://ipfs.filebase.io/ipfs/$ROOT/query-table.parquet" -o query-table.parquet
duckdb -c "SELECT count(*) FROM 'query-table.parquet'"
duckdb -c "SELECT count(*) FROM 'query-table.parquet' WHERE roof_age_years >= 15"
```

## 4. The artifact manifest

```bash
jq '{schemaVersion, runId, root, count: (.artifacts|length), sample: .artifacts[0:3]}' \
  artifacts/manifest-$(jq -r .runId artifacts/latest.json).json
```

Every artifact with its CID, logical name, byte size, codec and SHA-256. The IPNS name is
shown next to the CID it resolved to, because a pointer is not a snapshot.

## 5. Retrieval from two independent public gateways

```bash
COV=$(jq -r '.artifacts[] | select(.name=="coverage.json") | .cid' artifacts/manifest-*.json | head -1)
curl -sL "https://gateway.pinata.cloud/ipfs/$COV" | sha256sum
curl -sL "https://gw.ipfs-lens.dev/ipfs/$COV" | sha256sum
jq -r '.artifacts[] | select(.name=="coverage.json") | .sha256' artifacts/manifest-*.json | head -1
```

The two digests must match each other and the manifest. `artifacts/verification-<run>.json`
records which gateways answered for every artifact checked, with the bytes and digest each
returned.

## 6. A later run produces a new CID without mutating the old one

```bash
jq '[.runs[] | {runId, rootCid, mode, tables: .tables[0]}]' artifacts/run-history.json
PRIOR=$(jq -r '.runs[1].rootCid' artifacts/run-history.json)
curl -sI "https://ipfs.filebase.io/ipfs/$PRIOR/coverage.json" | head -1
```

The prior CID still resolves, the new run has a distinct CID, the IPNS name now points at
the new one, and both are in the history. The run history refuses to modify or drop a run
already recorded.

## 7. Aged roofs within a radius, in the UI

Drop a pin, set the radius, set the roof-age threshold to 15. Results carry roof age, the
basis that age was derived from, coordinates and per-row source systems.

## 8. Open roofing permits, longest open first

The same view sorted by open duration. Contractor and BBB columns are present and empty,
with the reason shown from `enrichment_status` rather than left blank.

## 9. The same questions through the agent

> Which properties in Lake County within five miles of Clermont have roofs older than 15 years?

> Which properties near that area have open roofing permits that have been open for many
> years, and who is the listed contractor?

The agent answers from the same data layer and cites its sources. On the second question it
must say plainly that contractor identity is not available and why, rather than inventing a
name.

## 10. MCP readiness

```bash
curl -s localhost:8787/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools[].name'
```
