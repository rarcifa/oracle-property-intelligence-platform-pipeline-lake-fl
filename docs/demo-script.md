# Demo script — Lake County, FL

## Current partial submission walkthrough

The [September 17 delivery](submission-handoff-20260917.md) identifies the exact
hosted snapshot and recording. `record-preview.mjs` is a separate partial
walkthrough: selected-run publication metadata, all-business conservation, ten
MCP tools, actual radius/age filters, executed SQL, canonical agent answers
independently replayed against hosted queries, and two public manifest digest
checks. It also shows retained Clermont `ROOF/REROOF + ISSUED` observations
with raw issued dates and a prominent not-currently-open caveat. When selected
successful history contains a changed-record incremental run, it freshly checks
both old/new manifests, raw directory root blocks and changed table bytes by CID
through two public gateway hosts. This recording does not itself publish or
rewrite history. It reports `fullAssignmentDemoPassed: false` while current-open
duration and ten-year ownership conclusions remain unsupported.
The strict full-demo contract below is unchanged and remains unpassed.

## Strict full-assignment demo

This script records one **explicit finalized public release**. It refuses to start when the
deployed run/root/coverage, full business-account table, complete Clermont evidence,
contractor posture, or MCP tool surface does
not match that release. The older public runtime and the one-year local candidate therefore
cannot be presented as the completed submission and must not lend their CIDs or verification
receipts to a newer run.

The hosted UI and public gateway views are real. Before recording, the script reads the
two operator-selected immutable manifest files and performs fresh public size/digest checks
for every current CID, the manifest itself and the predecessor query bytes. Local manifests
are not substituted for public retrieval. The source-only partial export cannot pass the
full current/open-roofing demo; neither it nor the stale hosted app is submission-ready.

```bash
U=https://tf2ynypdvfkv4dqxszpkj5emjq0imyxh.lambda-url.us-east-2.on.aws
RUN='<final verified incremental run ID>'
ROOT='<that run manifest root CID>'
MANIFEST='<path to that exact immutable manifest JSON>'
PRIOR_MANIFEST='<path to its prior successful manifest JSON>'

DEMO_BASE_URL="$U" DEMO_RUN_ID="$RUN" DEMO_ROOT_CID="$ROOT" \
  DEMO_MANIFEST_PATH="$MANIFEST" DEMO_PRIOR_MANIFEST_PATH="$PRIOR_MANIFEST" \
  pnpm --filter @oracle-lake/ui exec node scripts/record-demo.mjs out/
```

Before Playwright creates a video, the recorder asserts `/api/meta/run` names exactly
`$RUN/$ROOT`, the coverage has the same run ID, `/mcp` exposes the expected ten tools,
all source/unmatched business accounts are queryable, and the contractor view and coverage
snapshot report complete 2015–2026 Clermont evidence as one of 15 jurisdictions while BBB
remains zero and policy/API-gated. Any missed beat exits non-zero; an incomplete take is never
reported as a successful recording. It also refuses source-only held decisions, unchanged
query bytes presented as incremental ingestion, missing directory CAR mappings, incomplete
two-gateway checks, or a predecessor absent from successful history. During recording,
uncaught browser/console errors and an empty app root reject the take.

## 1. The published run

Open `/#/tenant`. The header names the run and the immutable root CID the browser is reading
from public IPFS — visible on every subsequent frame, so no beat can quietly change dataset.

```bash
curl -s "$U/api/meta/run" | jq '.run | {runId, rootCid, ipnsName, resolvedCid, propertyCount}'
```

Normal deployments resolve IPNS. The submission deliberately pins an explicit
run/root and matching coverage. Read the current exact identities and publication
state from the hosted metadata and delivery receipt; neither a private candidate
nor an older deployment may borrow a later successful publication's identity.

## 2. Aged roofs, by radius — the assignment's first question

In `/#/search`, type: `aged roofs in Clermont`, then explicitly set latitude
`28.5494`, longitude `-81.7729`, radius `5` miles and age threshold `16`.

The interpreted filters and radius controls stay visible. Ages are whole years:
strictly older than 15 uses `minRoofAge = 16`; an at-least-15 question uses 15. Results
carry roof age, the basis that age was derived from, coordinates, and per-row source systems.

```bash
curl -s "$U/api/properties?lat=28.5494&lon=-81.7729&radiusMiles=5&minRoofAge=16&limit=5" \
  | jq '{matched, first: .rows[0] | {parcel_identifier, roof_age_years, roof_age_basis}}'

COUNTY=$(curl -fsS "$U/api/properties?minRoofAge=15&limit=1" | jq -er '.matched')
FIVE=$(curl -fsS "$U/api/properties?lat=28.5494&lon=-81.7729&radiusMiles=5&minRoofAge=15&limit=1" | jq -er '.matched')
ONE=$(curl -fsS "$U/api/properties?lat=28.5494&lon=-81.7729&radiusMiles=1&minRoofAge=15&limit=1" | jq -er '.matched')
test "$ONE" -le "$FIVE" && test "$FIVE" -le "$COUNTY"
printf 'aged roofs: county=%s five_miles=%s one_mile=%s\n' "$COUNTY" "$FIVE" "$ONE"
```

Year built is an allowed low-confidence building-age proxy, not measured roof age.
Partial permit history may omit replacements. Next query `open roofing permits in
Clermont`, explicitly restore the same radius and set minimum roofing permit days open
to `365`; inspect literal status, lifecycle/as-of/duration basis and source-listed names.

The displayed counts are read from this exact finalized runtime instead of copied from an
older candidate. The one-mile count must not exceed the five-mile count, which must not
exceed the county count; the radius is a real great-circle distance rather than a bounding
box.

## 3. What the data cannot say

Open `/#/contractor`. Source-listed contractor names are populated only where the retained Clermont
2015–2026 harvest names one. The other 14 permitting jurisdictions do not have accessible
contractor coverage, and BBB ratings remain gated at source and null.

```bash
curl -s "$U/api/views/contractor" \
  | jq '{contractor_names_present: .posture.contractor_names_present,
         bbb_ratings_present: .posture.bbb_ratings_present, gating, note}'
```

Every displayed contractor count is therefore labelled Clermont-only, never countywide.
Missing extraction, unavailable detail and an authoritatively established absence are
different states. No missing contractor is promoted to proven absence. Source-listed
names are not verified licensing or historical legal-company relationships.

In the partial walkthrough, enable **Clermont ROOF/REROOF + source ISSUED
(with issue date)**. The 266 dated historical source rows are actual retained
records, not a replacement harvest. They can be inspected alongside their raw
status/type/date and source-listed names. Neither issue-date age nor `ISSUED`
is relabelled as current-open duration. The unfiltered table still retains all
58,495 Clermont rows and the acquired CD Plus rows, including valid unlinked
records.

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

Also inspect the account-grain table and `/api/businesses?linked=false&limit=5`.
All 33,346 source accounts must be queryable, including 31,286 valid unmatched accounts;
4,451 address-based candidate parcel associations are not distinct business companies.
Raw payloads and fiduciary/contact fields are private, not demo artifacts.

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

> Which properties in Lake County within five miles of Clermont have roofs older than 15 years?

Then ask separately:

> Which properties within five miles of Clermont have open roofing permits that have been open for many years, and who is the listed contractor?

The OpenAI-backed agent must answer with cited tool calls against the published run and apply
the row-level evidence boundaries: explain the roof-age proxy, report source-listed names
when present, state duration/as-of assumptions and missing BBB data, and distinguish unknown
from proven absence. It must not turn the Clermont-only count into countywide coverage. If
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

Older receipts cover only selected objects and are not complete proof. The repaired
publisher requires matching public bytes from two independent gateways for **every**
manifest entry and the manifest itself. Directory digests hash raw dag-pb bytes, fetched
with `?format=raw`, not HTML listings. Redirects to one host do not count as two gateways.
The manifest's `directoryCars` maps every directory to an actual CID-addressed CAR file;
the archive declares each directory as a root, contains every reachable block and is
validated offline. A `?format=car` URL alone is not delivered CAR proof.

The recorder visibly retrieves the actual manifest from two successful gateways and shows
the hosted run history. Its later incremental run must contain changed query bytes and a
distinct root; predecessor query bytes are freshly retrieved, not assumed from history.

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

The release demo requires exactly ten tools, including `getPropertyPermits` and
`listOracleBusinessAccounts`. This is an implementation consistency check, not an invented
assignment rubric weight. The actual same-release run summary must show counts by source,
collection timestamps and limitations; unknown historic capture times stay unknown.

Finally show the portable consumer DuckDB/MCP read path, who funds pinning/optional hosting
and model usage, and the Oracle/builder evidence together. No live owner messaging or
Roofing CRM workflow demonstration is required. Both original agent prompts, source-count
summary, manifest/two gateways, later immutable snapshot and CAR delivery must be present;
an unavailable-agent notice or source-only refusal is an honest limitation, not a passed beat.
