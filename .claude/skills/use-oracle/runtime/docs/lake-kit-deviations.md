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
| `src/core/artifact-manifest.mjs` | `elephant.artifact-manifest.v1` with cid, name, size, codec, sha256, origins |
| `src/core/gateway-verify.mjs` | Byte and digest agreement across independent public gateways |
| `src/core/run-history.mjs` | `elephant.run-history.v1`, immutable prior runs, record deltas |

The CID implementation was cross-checked against the canonical `ipfs-unixfs-importer` at
sizes spanning 0 bytes to 50 MB, including nested directories, and matches on every case
including Tsize.

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
| `espeon` + `build-rag-systems` | Semantic retrieval question-answering, a distinct scoring line | Silently substituted by the tool-calling chat agent when the UI work was delegated |
| `donphan` + `use-elephant-mcp` | The post-publish MCP smoke test that `use-oracle` step 13 requires | The bundled elephant MCP server failed to connect at session start and the step was never re-queued |
| `smeargle` + `responsive-design-tests` | Breakpoint coverage before a demo video | Never named by arceus, because the routing prompt described the UI as functional requirements and never said it would be visually assessed |

Two consequences follow that are worth naming. The county was never registered in
`catalog/published-counties.json`, so `catalog:update` and `catalog:sync-mcp-json` never
ran and the root `.mcp.json` contains no reference to Lake. And the UI has no component
tests and two media queries.

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

**IPNS resolution is not universal across gateways.** `ipfs.filebase.io` resolves
`/ipns/<name>/…` and returns the published files. `gateway.pinata.cloud` answers 403 for
IPNS paths while serving `/ipfs/<cid>` paths normally. This is the reason the assignment's
framing is right: the IPNS name is a convenience pointer and the CID is the identity. Every
run records both, and all retrieval evidence is gathered against CIDs.
