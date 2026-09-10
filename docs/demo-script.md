# Demo script — Lake County, FL

Follows the assignment's demo transcript beat for beat, against the **deployed runtime**.
Every number comes from a query against the published run; none are typed by hand.

There is no local step anywhere in this script. If a beat renders, the hosted runtime served
it — that is the point of running it this way rather than from a checkout.

```bash
U=https://tf2ynypdvfkv4dqxszpkj5emjq0imyxh.lambda-url.us-east-2.on.aws
RUN=$(curl -s "$U/api/meta/run" | jq -r .run.runId)
ROOT=$(curl -s "$U/api/meta/run" | jq -r .run.rootCid)
```

The recorded walkthrough is reproducible: `pnpm --filter @oracle-lake/ui exec node
scripts/record-demo.mjs out/` drives these same beats in a real browser and writes the video.

## 1. The published run

Open `/#/tenant`. The header names the run and the immutable root CID the browser is reading
from public IPFS — visible on every subsequent frame, so no beat can quietly change dataset.

```bash
curl -s "$U/api/meta/run" | jq '.run | {runId, rootCid, ipnsName, resolvedCid, propertyCount}'
```

The runtime holds no baked dataset CID. It resolves the IPNS name and serves whatever
immutable root that name points at, so a scheduled publish lands without a redeploy.

## 2. Aged roofs, by radius — the assignment's first question

In `/#/search`, type: `aged roofs with an open roofing permit in Clermont`.

The phrase compiles into explicit filters — `city = CLERMONT`, `minRoofAge = 15`,
`hasOpenRoofingPermit = true` — so the query stays inspectable rather than opaque. Results
carry roof age, the basis that age was derived from, coordinates, and per-row source systems.

```bash
curl -s "$U/api/properties?lat=28.5494&lon=-81.7729&radiusMiles=5&minRoofAge=15&limit=5" \
  | jq '{matched, first: .rows[0] | {parcel_identifier, roof_age_years, roof_age_basis}}'
```

County-wide, 117,605 parcels meet the 15-year threshold; 23,638 fall within five miles of
Clermont, 1,403 within one mile — monotonic, because the radius is a real great-circle
distance and not a bounding box.

## 3. What the data cannot say

Open `/#/contractor`. Contractor of record and BBB ratings are gated at source behind HTTP 403. They are real columns that stay null, each carrying its gating reason.

```bash
curl -s "$U/api/views/contractor" | jq '{gating, note}'
```

Nothing here is invented to fill the gap. That is the whole claim.

## 4. Business coverage, including its own double count

Open `/#/business`.

```bash
curl -sL "https://ipfs.filebase.io/ipfs/$ROOT/coverage.json" | jq '.tables.businessAccounts'
```

33,346 accounts in the TPP roll; 32,738 carry a situs address; 2,060 match a parcel. Summing
per-parcel counts gives 4,451 across 2,726 parcels, because 90 shared-address groups are
attributed to every parcel at that address. Published, not hidden.

## 5. Read-only SQL, in the browser

Open `/#/sql`. Run a real aggregate:

```sql
SELECT address_city, count(*) AS aged_roofs
  FROM properties
 WHERE roof_age_years >= 15
 GROUP BY 1 ORDER BY 2 DESC LIMIT 10
```

It executes client-side with DuckDB-WASM against the published Parquet — no backend query
service in the path. Then press **Try a rejected statement**: `DROP TABLE properties` is
refused before it reaches DuckDB, rather than sanitised.

```bash
curl -s "$U/api/sql" -H 'content-type: application/json' \
  -d '{"sql":"SELECT * FROM read_text('"'"'/etc/passwd'"'"')"}' | jq .error   # sql_rejected
```

## 6. The agent, on the same data

Open `/#/ask` and ask the question that has an unanswerable half:

> Within five miles of Clermont, which properties have roofs older than 15 years and an open
> roofing permit — and who is the contractor?

It answers the answerable half with cited tool calls against the published run, then says
plainly that contractor identity is gated at source. It does not produce a plausible name.

## 7. Retrieval from public IPFS, and immutability

```bash
# The same bytes, from independent gateways
for G in ipfs.filebase.io gateway.pinata.cloud gw.ipfs-lens.dev; do
  echo -n "$G "; curl -sL "https://$G/ipfs/$ROOT/coverage.json" | sha256sum
done

# Prior roots still resolve — a new run never mutates an old one
curl -s "$U/api/meta/run" | jq -r '.runHistory.runs[].rootCid'
```

`artifacts/verification-<run>.json` records which gateways answered for every artifact, with
the digest each returned. Directory digests hash the dag-pb node bytes, so a verifier can
refetch a block and check it independently.

## 8. MCP readiness

```bash
curl -s "$U/mcp" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq -r '.result.tools[].name'

# A misspelled argument is rejected, not silently ignored:
curl -s "$U/mcp" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"findOpenRoofPermits","arguments":{"minOpenDays":3000}}}' \
  | jq -r '.result.content[0].text' | jq .error        # invalid_arguments

# The real filter narrows: 0 / 365 / 3000 → 226 / 9 / 1
```
