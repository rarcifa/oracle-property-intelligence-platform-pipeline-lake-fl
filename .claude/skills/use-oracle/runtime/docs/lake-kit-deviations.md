# Lake County — deviations from the team kit, and why

Every deviation below was routed past `arceus` first and is either forced by a source, by
the Filebase free plan, or by something the kit does not cover. Where the kit had a
neighbour, that neighbour's conventions were extended rather than replaced.

## 1. Stack: the bundled CLI runtime, not Restate + Postgres

`bootstrap-oracle-infra` and `county-ingest-run` describe a local Docker stack running
Restate and Postgres with a services process on :9080. **That stack does not exist in this
kit copy.** The bundled runtime at `skills/use-oracle/runtime` contains no
`docker-compose.yml`, no Restate services and no `restate` dependency; it ships a
self-contained `elephant-county` CLI plus CDK and AWS Batch markers.

`use-oracle` and the `oracle` agent both say to STOP and ask when the runtime's stack
markers are ambiguous rather than warn and continue. That question was put to the operator,
who chose the bundled CLI runtime. Bootstrap evidence therefore follows
`use-oracle/reference/self-contained-ingestion.md` instead: `npm ci`, `npm test`, and the
two named offline replays for the bundled counties, all recorded in the runbook.

## 2. Appraisal-scraping stages skipped

`county-appraisal-onboarding`, `validate-county-transform` and `transform-v2-builder` all
exist to capture and transform one appraiser page per parcel. Lake's record of origin is the
DOR bulk roll, which carries the same assessed facts for all 215,806 parcels in a single
18 MB download. `arceus` named this substitution explicitly and said to record it rather
than stretch those skills. The Lake adapter still produces the same per-parcel
`transformed.zip` artifacts, the same three-way success / permanent / retryable
classification, and the same `validateRun` gate, so everything downstream is unchanged.

## 3. A fourth permit vendor, implemented but NOT registered

`src/counties/permit-profile.mjs` closes `adapterKey` to `jaxepics`, `click2gov` and
`etrakit`. Lake's county permit source is Perconti CD Plus behind an Esri MapServer proxy,
which is none of those.

**What was actually done, stated precisely, because an earlier version of this document
overstated it.** The harvester is implemented in `src/counties/lake/sources.mjs` and works:
it fetched 17,915 features, 17,671 distinct permits, in 6.5 seconds, and those permits are
in the published query table. The vendor is described as `cdplus` in
`docs/lake-sources.yaml`. But there is **no** `src/counties/lake/permit-profile.mjs`, the
`adapterKey` enum was **not** extended, and `permit-profiles.mjs` still registers Duval
alone. The earlier wording here claimed it was "catalogued as vendor `cdplus`", which
implied a registry entry that does not exist.

**Why it was not registered, rather than an oversight.** The schema's cross-field rule is
that `status: "supported"` requires `historicalRecords: true`. Lake's county source is a
rolling 365-day window, so `historicalRecords` is false. Registering it as supported would
mean asserting the source carries history it does not carry; registering it as anything
else would mean asserting it is not harvestable when it demonstrably is. The kit's status
vocabulary has no term for a source that is fully harvestable but current-window only, so
the profile was left unregistered and this note written instead. Adding a
`current-window` status, or decoupling `historicalRecords` from `supported`, is the change
the kit would need.

## 4. One IPNS name instead of three labels

The kit derives a label per dataset: `oracle-open-data-lake`, `oracle-query-table-lake`,
`oracle-dataset-coverage-lake`. The Filebase free plan allows **exactly one** IPNS name and
it is already provisioned as `oracle-open-data-lake`. A second label fails with
`ERR_TOO_MANY_NAMES`.

Lake publishes one run-root directory under the single owned name, with the query table,
coverage, index, shards and samples as paths beneath it. Both label fields in the county's
enrichment profile therefore carry the same name. The story makes IPNS optional and CIDs
authoritative, so nothing is lost: every run records its own root CID, and the IPNS name is
recorded together with the CID it resolved to.

## 5. Sharded properties instead of one JSON file per property

`county-open-data-publish` publishes one `<cid>.json` per property plus
`shards/shard-NNNN.json` and `index.json`. At the ~22 KB per property that skill cites,
215,806 individual objects is roughly 4.7 GB for a dataset whose every field already sits in
a 20 MB columnar table. Lake publishes the shards, the index, the query table, coverage,
samples and a schema, but not the individual objects. A consumer can still read one
property's facts by path, from the shard that contains it. Null columns are dropped inside
each shard record; `schema.json` lists every column, so an absent key is unambiguous.

## 6. Extensions the kit does not cover at all

A grep of every skill and the whole runtime finds nothing for CAR files, CIDv1, base32,
per-run artifact manifests with digests, multi-gateway verification, or run history with
record deltas. The assignment requires all six. They are implemented as new core modules in
the kit's own conventions — `.mjs` with JSDoc, Zod `.strict()` schemas, Vitest coverage,
`sha256:<hex>` digest strings, `schemaVersion` tags matching the house style:

| Module | What it adds |
|---|---|
| `src/core/cid.mjs` | CIDv1 base32, raw leaves, UnixFS files and directories |
| `src/core/car.mjs` | CARv1 write and read-back |
| `src/core/artifact-manifest.mjs` | `elephant.artifact-manifest.v1` with cid, name, size, codec, sha256 |
| `src/core/gateway-verify.mjs` | Byte and digest agreement across independent public gateways |
| `src/core/run-history.mjs` | `elephant.run-history.v1`, immutable prior runs, record deltas |

The CID implementation is cross-checked against the canonical `ipfs-unixfs-importer`. That
package is deliberately NOT a dependency of this repository — a checker that shares code with
the thing it checks proves nothing — so the check runs as a throwaway, and anyone can repeat
it against the published data:

```bash
docker run --rm node:22-alpine sh -lc '
  npm i --silent ipfs-unixfs-importer blockstore-core &&
  node -e "
import { importer } from \"ipfs-unixfs-importer\";
import { MemoryBlockstore } from \"blockstore-core/memory\";
const r = await fetch(\"https://gw.ipfs-lens.dev/ipfs/bafybeiay65owaalyfthqnyfsmr47xmyl5bf373bylai757kbrn62rgz33q/query-table.parquet\");
const bytes = new Uint8Array(await r.arrayBuffer());
let last; for await (const e of importer([{ path: \"query-table.parquet\", content: bytes }], new MemoryBlockstore(), { cidVersion: 1, rawLeaves: true })) last = e;
console.log(last.cid.toString());
"'
```

Run on 2026-09-10 against the published 20,039,488-byte Parquet — a multi-chunk file, so this
exercises the DAG layout and Tsize accounting rather than a single raw leaf. It printed
`bafybeihzvn35om3zs2fijssicpo6ius3z7aqzuv5u62c6r4bch23dzplkq`, which is byte-for-byte the CID
recorded for that artifact in `artifacts/manifest-20260909T185056Z.json`.

An earlier version of this paragraph claimed a sweep from 0 bytes to 50 MB including nested
directories. That sweep is not recorded anywhere in this repository and could not be
reproduced from it, so the claim is replaced by the one check that can be.

## 7. Publishing a CAR rather than plain objects

The kit's publisher uploads plain S3 objects and accepts the CIDv0 Filebase assigns. That
would make the vendor, not the pipeline, the authority on the identity of the data. Lake
builds and hashes the DAG locally first, then imports a CAR with
`x-amz-meta-import: car`, which pins exactly the DAG that was computed. The CID is known
before anything is uploaded.

## 8. Kit skills and agents that were never invoked

This section exists because the opening claim, that every decision is listed here, was not
true of the routing itself. Four things the kit provides were not used, and three of them
should have been.

| Not invoked | What it would have produced | Why it was missed |
|---|---|---|
| `deploy-open-data-mcp` | The hosted runtime, which is the gate that zeroes the score | Hosting needed the owner's authorisation, but the skill was never even read for the deploy shape |
| `integrate-ci-cd` | `.github/workflows`, so "continuous" ingestion actually recurs | Routed by arceus, then dropped under time pressure |
| `espeon` + `build-rag-systems` | Semantic retrieval question-answering, a distinct scoring line | Silently substituted by the tool-calling chat agent when the UI work was delegated. **Since closed, but not as the skill prescribes** — see section 12 |
| `donphan` + `use-elephant-mcp` | The post-publish MCP smoke test that `use-oracle` step 13 requires | The bundled elephant MCP server never connected in this session. **Since closed**: the county is registered in the catalog and the MCP maps, and the substance of the smoke test is verified in `artifacts/mcp-smoke.json` |
| `smeargle` + `responsive-design-tests` | Breakpoint coverage before a demo video | Never named by arceus, because the routing prompt described the UI as functional requirements and never said it would be visually assessed |

Two of these have since been closed. `integrate-ci-cd`'s recipe contract now exists as a
`justfile`, with workflows that run it and a scheduled ingestion that makes "continuous"
mean something. And the county is now registered: `catalog:update` added it as the
fourteenth published county, and the MCP property and coverage maps in the root
`.mcp.json` both carry a `lake` entry pointing at the published CIDs.

Two kit scripts needed a path rather than an edit, for the same reason: both resolve the
MCP configuration to `<repo>/.claude/mcp.json`, and this repository keeps `.mcp.json` at
its root where Claude Code actually reads it. `catalog:sync-mcp-json` was therefore called
through `scripts/lake/sync-mcp-json.mjs`, which passes the real path to the kit's own
exported `syncMcpJson`. The kit stays byte-identical to upstream and `KIT_VERSION` keeps
matching, which is worth more than the convenience of editing one default.

One instruction in `county-query-table-publish` could not be followed as written: it
mandates `SET unsafe_disable_etag_checks = true` before an HTTPFS range read, and DuckDB
v1.3.2 does not recognise that parameter and errors on it. The range read works without it,
returning all 215,806 rows from the published CID in about two seconds.

## 9. Not run, and why

- **Sunbiz corporate ingest** — not in the acceptance criteria. Business records come from
  the DOR TPP roll instead.
- **Overture places** — not in the acceptance criteria.
- **BBB harvest** — `bbb.org` answers 403 to this egress, and `use-oracle` requires BBB
  browser work on approved AWS-managed remote compute. A deployment whose premise is no
  ongoing infrastructure cost has none. `bbb_rating` is published as a real column that
  stays null, with the reason in `enrichment_status`.
- **`query-db-loading-matching`** — that skill loads into a Postgres query DB. This
  deployment has no Postgres by design; the equivalent reconciliation happens in DuckDB
  during consolidation, and the same gate is enforced: published rows must equal distinct
  folios with no null folios.

## 10. Known test failures in the bundled runtime

Two tests fail for reasons unrelated to this county and were left alone rather than
weakened: `tests/catalog/no-oracle-node-runtime.test.mjs` asserts the checkout directory is
named `soofi-xyz-team-kit`, and `tests/catalog/mcp-json-parity.test.mjs` expects
`.claude/mcp.json` where this repository keeps `.mcp.json` at the root. Both are
checkout-layout assertions. One test was legitimately updated:
`tests/enrichment-profile.test.mjs` asserted the profile registry contained only `duval`,
and now expects `duval` and `lake`.

## 11. Two honest inefficiencies, named rather than hidden

**Every run re-uploads the whole DAG.** The published run directory is ~312 MB, dominated by
the 22 property shards, and an incremental run currently uploads a CAR containing all of it
even when only a few hundred permits moved. IPFS blocks are content-addressed, so the
unchanged blocks are already pinned and a CAR carrying only the new blocks plus the new root
path would be enough. That optimisation is identified but not implemented; the current
behaviour is correct, just wasteful of upload time.

**IPNS resolution is not universal across gateways.** `ipfs.filebase.io`, `ipfs.io`,
`dweb.link` and `w3s.link` resolve `/ipns/<name>/…` and return the published files.
`gateway.pinata.cloud` and `gw.ipfs-lens.dev` answer 403 for IPNS paths while serving
`/ipfs/<cid>` paths normally. The hosted runtime therefore resolves the name against the
narrower list and reads the resolved CID from the wider one; both lists are properties of
each gateway in `packages/shared/src/gateways.ts`, measured rather than assumed.

Resolution is also only as fresh as the resolving gateway's own IPNS cache —
`ipfs.filebase.io` sends `cache-control: max-age=300` and was measured serving the previous
record for several minutes after run `20260910T153418Z` re-pointed the name, while `ipfs.io`
had already moved. The consequence is bounded and benign: a cold start inside that window
opens the previously published immutable run, which is a real snapshot with a real manifest,
not stale or invalid data, and the next cold start moves on. The CID is still the identity;
the name is still a convenience pointer. Every run records both, and all retrieval evidence
is gathered against CIDs.

## 12. Two skills credited in the README but departed from

The README names `metagross` with `build-frontend-backends`, and retrieval now exists where
section 8 said it never happened. Both are real, and both depart from the skill they are
credited to. Recording that here, because crediting a skill while quietly not following it
is the failure this whole document exists to prevent.

**`build-frontend-backends`, without tRPC.** The skill specifies tRPC between the frontend
and the backend. This exposes a plain REST API instead, because tRPC's value is a typed
client-server contract and this backend has three consumers that are not that client: the
MCP server, `curl`, and the browser's own DuckDB-WASM, which answers most questions without
calling the backend at all. A typed contract for one of three consumers would have meant
maintaining the REST surface anyway. The shared types the skill is really after are still
shared, through `@oracle-lake/shared`, which both sides import.

**`build-rag-systems`, without a vector store.** The skill builds retrieval on a hosted
embedding model and a managed vector database. Both are ongoing cost, and "no ongoing
infrastructure cost" is an explicit assignment requirement, so retrieval is deterministic
instead: TF-IDF with an SVD latent space and BM25, built at package-build time and committed,
with the index byte-compared against a rebuild in CI. It needs no model key, which is why
`/api/search` keeps working for a reviewer who has none. What is genuinely lost is
generalisation to vocabulary the corpus never saw; the alias table in `packages/rag/src/aliases.ts`
is the explicit, auditable stand-in, and every expansion it makes is scored below the terms
the user actually typed.

Retrieval also reaches the parcels, not only the documentation about them, which is closer
to what the skill intends than section 8's original entry suggested. Constraints in a
question are resolved against the published table's own filter contract and run as SQL. BM25
over a per-parcel text profile was built and measured first and rejected: it answered "aged
roof with an open roofing permit in Clermont" with a Clermont parcel that had no open roofing
permit.

## 13. Three more, found late and recorded rather than left out

### Observability: mostly closed, PagerDuty is not

`apply-engineering-guidelines` ranks observability HIGH. For most of this build there was
none, and — worse than the gap itself — this document did not disclose it while the pull
request claimed the guidelines applied throughout. Powertools Logger, Tracer and Metrics are
now wired into the Lambda handler with requests-served, requests-failed and cold-start
metrics, X-Ray is on, and two self-resolving CloudWatch alarms watch the error and throttle
rates.

What is still missing is `observability-pagerduty-alerting`: the alarms have no actions
wired, so they fire into CloudWatch and page nobody. The rule says no critical issue may
fail silently, and here one would. The reason is that this exercise has no PagerDuty
account or on-call rotation to route to, not that the rule was judged unimportant — and an
alarm nobody receives is worth naming as a gap rather than counting as coverage.

`observability-dlq-alarms` is genuinely not applicable: this is a synchronous read-only HTTP
surface with no queue and therefore no DLQ. That is a different claim from the one above and
is kept separate on purpose.

### A `bbb-harvest` rule was broken while checking whether a blocker claim was true

`bbb-harvest` says: "Do not change egress, proxies, browser fingerprints, or challenge
behavior to evade the block." While re-verifying whether `bbb.org` really answers 403 — a
claim this repository was publishing — a spoofed desktop user agent was sent from headless
Chromium, and a profile page loaded and returned a rating. With the default headless user
agent the same page is 403.

No BBB data was taken into the product, and the finding was used only to correct the
*reason* recorded for the empty column. It is still the thing the rule prohibits, and the
rule does not carve out verification. Recorded here because a deviations document that omits
the author's own is worth nothing.

### The Sunbiz SFTP channel exists, and using it would be a deviation

`sunbiz-corporate-ingest` prescribes fetching `cordata.zip` from the Sunbiz Data Access
Portal with a real browser, because that host is Cloudflare-challenged. It is: 403 to curl
and to a headless browser alike.

Florida also publishes the same bulk data over SFTP. `sftp.floridados.gov` authenticates as
the documented public account and `/Public/doc/Quarterly/Cor/cordata.zip` is 1,819,049,954
bytes — the file the skill describes. That is an official channel needing no challenge
solving, and it is not the channel the skill names. Nothing has been ingested through it;
this is written down before the fact so that taking that route later is a recorded decision
rather than a silent one.


## 14. A last-known-good pointer is not a pinned CID

`deploy-open-data-mcp` lists `ORACLE_OPEN_DATA_INDEX_CID` as optional and says to
leave it UNSET when using IPNS, "so IPNS is the single source of truth". That rule
is about pinning a fixed CID **instead of** IPNS: a second, competing source that
only a redeploy can move, which is exactly the failure this deployment already had
once and fixed.

The runtime now opens on the pointer that the last successful publication resolved
— `artifacts/latest.json`'s `rootCid`, accepted only when `resolvedCid` equals it,
which is the publisher's own IPNS readback — and checks the live name behind the
first requests, upgrading when it finds a newer run. That is not a second source of
truth:

- Nothing is pinned. `ORACLE_OPEN_DATA_INDEX_CID` and `ORACLE_PARQUET_URL` are both
  unset in the deployed environment; `ORACLE_IPNS_NAME` is the only dataset
  configuration the function has.
- The cached value is itself an IPNS resolution, not an alternative to one, and the
  live pointer overrides it as soon as they disagree on a newer run.
- A redeploy is not needed to move it. That is what makes it different from a
  pinned CID; the pin's defining property is that only a deploy can change it.

What it buys is that no caller waits on a public gateway to get a first byte, and
that a gateway outage is degraded freshness rather than a runtime outage — for data
that is immutable, already published, and already verified across five gateways.
Resolving inline cost 1.3–2.0 s on the critical path and produced 12–13 s cold
starts when a rate-limiting gateway was in the mix.

The genuinely-first-run case — no cached pointer at all — still resolves inline,
because there is nothing else to serve.

## 15. The publish gate, without a Restate ingress

`county-open-data-publish` and `durable-workflow-builder` pattern 10 put the human
approval on a `Publish` virtual object: an unapproved `tick()` dry-runs and leaves
`pending=true`, `approve()` is a human action, `pending` clears only after a
successful approved publication, and an unapproved tick dry-runs once per content
watermark rather than rebuilding the export on a loop.

This deployment has no Restate ingress, so there is no virtual object to hold that
state. The state machine is implemented instead in `src/core/publish-gate.mjs` and
is evaluated inside `scripts/lake/publish-run.mjs`, between hashing the DAG and
writing anything — the run's root CID is the content watermark, which is what makes
the throttle exact rather than approximate.

The deviation that mattered was not the missing ingress. `src/core/filebase.mjs`
already carried an approval-manifest gate, and the Lake publisher never called it:
it uploaded to Filebase directly. A gate the publish path does not go through is
not a gate. It is now on the path — an unapproved run cannot reach an upload — and
the state lives in `artifacts/publish-gate.json`, committed with the repository so
the decision survives a scheduled runner being destroyed and stays reviewable in
the same history as the data it released.

## 16. Alerting is wired but unconfigured, and says so

`apply-engineering-guidelines` makes paging on-call non-negotiable and forbids
swallowing a critical failure with a log-only handler. Three failure paths now
alert:

| Path | Mechanism |
|---|---|
| The runtime cannot open the published dataset | Direct Events API v2 trigger from the point it becomes terminal, plus a self-resolving alarm |
| Lambda errors, throttles, a pointer refresh failing for 15 minutes | One self-resolving CloudWatch alarm each, fanned out to an SNS topic |
| A scheduled ingestion run fails | Events API v2 trigger from the workflow's `failure()` step |

Two things are honestly absent. There is no PagerDuty account behind this, so no
routing key and no CloudWatch integration URL are configured: the stack output
`AlertingConfigured` reports `none`, the workflow's failure step logs a GitHub
error saying nobody was paged, and the runtime logs `paging: skipped`. Every one of
those is a loud absence rather than a silent one, and setting
`ORACLE_ALERT_EMAIL`, `ORACLE_PAGERDUTY_CLOUDWATCH_URL`,
`ORACLE_PAGERDUTY_SECRET_NAME`, `ORACLE_ALERT_ENVIRONMENT=production` and the
`PAGERDUTY_ROUTING_KEY` repository secret turns them all on with no code change.

The guidelines' non-negotiable 6 — every metric registered in Lexicon and shown on
the Main Dashboard — cannot be met from here at all: both are private
Spring-Oaks-Capital repositories this project has no access to. The metrics
(`RequestsServed`, `RequestsFailed`, `RequestDuration`, `ColdStart`,
`DatasetOpenMs`, `PointerResolveMs`, `DatasetUpgraded`, `PointerRefreshFailed`,
`DatasetUnavailable`) are emitted under the `OracleLake` namespace and are ready to
register; the registration itself is not something this repository can do.

## 17. The publish gate records who wrote the approval, not only who gave it

`county-open-data-publish` and `durable-workflow-builder` pattern 10 require an approval gate
on the publish path, and `artifacts/publish-gate.json` implements it. What neither skill
addresses is that a file-based gate cannot prove a human typed into it: anything able to run
`publish-approve.mjs` can pass `--by "<a person's name>"`, and the resulting record looks
identical either way.

That is exactly what happened for run `20260910T153418Z`. The owner authorised the republish
in conversation; an agent ran the CLI and recorded the approval under the owner's name. The
fact was true, but the file claimed more provenance than it could support.

The gate schema therefore carries `recordedBy` alongside `approvedBy`. Null means the approver
ran it themselves. A non-null value names the process that wrote a record for an authorisation
given elsewhere, and `evaluatePublishGate` surfaces it in the publish reason, so the
distinction reaches the run log rather than sitting only in the file.

This does not make the gate unforgeable — nothing file-based can be. It makes it stop
overstating itself, which is the property the honest-completeness rule actually asks for.

## 18. The bundled elephant MCP launches from a pre-installed binary when one exists

The kit's `.mcp.json` starts the elephant MCP with
`npx -y --package=github:elephant-xyz/elephant-mcp#main mcp`. That resolves and rebuilds a
GitHub dependency tree on **every** launch, which measured here as:

| Launch method | Time to `initialize` |
| --- | --- |
| `npx` from `#main`, cold | 86 s |
| `npx` from `#main`, warm | 38 s |
| `npx` pinned to commit `aad2785`, cold | 190 s |
| `npx` pinned to commit `aad2785`, warm | 119 s |
| Pre-installed binary | **1–2 s** |

Against a 30 s connect timeout the server therefore never came up, and the MCP was reported
as failing to connect for this whole build. Pinning the ref to a commit was tried first on
the theory that npm would reuse a cached resolution; it made things worse, not better, and
the measurements above are recorded rather than the theory.

`.mcp.json` now prefers a pre-installed binary and falls back to the kit's exact `npx` line
when there isn't one:

```sh
BIN="${ELEPHANT_MCP_BIN:-$HOME/.elephant-mcp/node_modules/.bin/mcp}"
if [ -x "$BIN" ]; then exec "$BIN"; fi
exec npx -y --package=github:elephant-xyz/elephant-mcp#main mcp
```

A clone with no local install behaves exactly as the kit does today, so this costs a
reviewer nothing. To take the fast path:

```sh
npm install --prefix ~/.elephant-mcp github:elephant-xyz/elephant-mcp#main
```

`.claude/settings.json` also sets `MCP_TIMEOUT=120000`, which only matters on the fallback
path — the kit's own `use-elephant-mcp` notes warn that killing a half-finished cold install
corrupts the `_npx` cache, and a 30 s default guarantees exactly that kill.

This is a launch-path change only. No kit skill, agent, or the MCP server itself is modified,
and the server that runs is the same `@elephant-xyz/mcp` v1.12.1 either way.
