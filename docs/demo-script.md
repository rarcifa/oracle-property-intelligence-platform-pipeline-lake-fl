# Demo script — Lake County, FL

This script records one **explicit finalized public release**. It refuses to start when the
deployed run/root, complete Clermont evidence, contractor posture, or MCP tool surface does
not match that release. The older public runtime and the one-year local candidate therefore
cannot be presented as the completed submission and must not lend their CIDs or verification
receipts to a newer run.

There is no local step anywhere in this script. If a beat renders, the hosted runtime served
it — that is the point of running it this way rather than from a checkout.

```bash
U=https://tf2ynypdvfkv4dqxszpkj5emjq0imyxh.lambda-url.us-east-2.on.aws
META=$(curl -fsS "$U/api/meta/run")
RUN=$(printf '%s' "$META" | jq -er .run.runId)
ROOT=$(printf '%s' "$META" | jq -er .run.rootCid)

DEMO_BASE_URL="$U" DEMO_RUN_ID="$RUN" DEMO_ROOT_CID="$ROOT" \
  pnpm --filter @oracle-lake/ui exec node scripts/record-demo.mjs out/
```

Before Playwright creates a video, the recorder asserts `/api/meta/run` names exactly
`$RUN/$ROOT`, `/mcp` exposes the expected nine tools, and the contractor view and coverage
snapshot report complete 2015–2026 Clermont evidence as one of 15 jurisdictions while BBB
remains zero and policy/API-gated. Any missed beat exits non-zero; an incomplete take is never
reported as a successful recording.

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

COUNTY=$(curl -fsS "$U/api/properties?minRoofAge=15&limit=1" | jq -er '.matched')
FIVE=$(curl -fsS "$U/api/properties?lat=28.5494&lon=-81.7729&radiusMiles=5&minRoofAge=15&limit=1" | jq -er '.matched')
ONE=$(curl -fsS "$U/api/properties?lat=28.5494&lon=-81.7729&radiusMiles=1&minRoofAge=15&limit=1" | jq -er '.matched')
test "$ONE" -le "$FIVE" && test "$FIVE" -le "$COUNTY"
printf 'aged roofs: county=%s five_miles=%s one_mile=%s\n' "$COUNTY" "$FIVE" "$ONE"
```

The displayed counts are read from this exact finalized runtime instead of copied from an
older candidate. The one-mile count must not exceed the five-mile count, which must not
exceed the county count; the radius is a real great-circle distance rather than a bounding
box.

## 3. What the data cannot say

Open `/#/contractor`. Contractor of record is populated only where the certified Clermont
2015–2026 harvest names one. The other 14 permitting jurisdictions do not have accessible
contractor coverage, and BBB ratings remain gated at source and null.

```bash
curl -s "$U/api/views/contractor" \
  | jq '{contractor_names_present: .posture.contractor_names_present,
         bbb_ratings_present: .posture.bbb_ratings_present, gating, note}'
```

Every displayed contractor count is therefore labelled Clermont-only, never countywide.
Where Clermont publishes a permit but no contractor, the row records
`contractor_absent_on_permit`; outside that evidence boundary it records
`contractor_gated_403`. Nothing is inferred to fill either null.

## 4. Business coverage, including its own double count

Open `/#/business`.

```bash
BUSINESS=$(curl -fsS "$U/api/views/business")
COVERAGE=$(curl -fsSL "https://ipfs.filebase.io/ipfs/$ROOT/coverage.json")

# Refuse figures from another runtime/run/root, then print only internally consistent values.
jq -en --arg run "$RUN" --arg root "$ROOT" \
  --argjson business "$BUSINESS" --argjson coverage "$COVERAGE" '
  ($business.provenance.runId == $run and $business.provenance.rootCid == $root) and
  ($coverage.runId == $run) and
  ($business.totals.business_accounts == $coverage.tables.businessAccounts.attributedAcrossParcels) and
  ($business.totals.properties_with_accounts == $coverage.tables.businessAccounts.propertiesWithAccount) and
  ($coverage.tables.businessAccounts.matchedToParcel <= $coverage.tables.businessAccounts.withSitusAddress) and
  ($coverage.tables.businessAccounts.withSitusAddress <= $coverage.tables.businessAccounts.rows)
  | if . then $coverage.tables.businessAccounts else error("business release mismatch") end'
```

Read the six figures from that command's output: source accounts, accounts with a situs
address, distinct accounts matched to a parcel, account-to-parcel attributions, properties
with an account, and shared-address groups. The recorder uses those same fields from the
selected runtime and fails before opening a browser if their provenance or arithmetic does
not match `$RUN/$ROOT`.

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

If the public runtime reports `chatEnabled: true`, open `/#/ask` and ask the question that
has an unanswerable half:

> Within five miles of Clermont, which properties have roofs older than 15 years and an open
> roofing permit — and who is the contractor?

The OpenAI-backed agent must answer with cited tool calls against the published run and apply
the row-level contractor semantics: report a published Clermont contractor when present,
state an established absence for `contractor_absent_on_permit`, and state the source gate for
`contractor_gated_403`. It must not turn the Clermont-only count into countywide coverage. If
the model key is not configured, the expected result is the explicit `chat_unavailable`
notice; use the REST/MCP queries instead and do not present the notice as a passing agent
demo.

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

# Record the actual counts returned by this immutable public run; do not copy
# counts from the newer local candidate.
```

The release demo requires exactly nine tools, including `getPropertyPermits`. Eight tools is
evidence that the hosted runtime is stale, and the recorder fails before opening a browser.
