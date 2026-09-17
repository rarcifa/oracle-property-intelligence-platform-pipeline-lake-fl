# Oracle Property Intelligence Platform Pipeline - Lake County, FL

A continuous, incremental ingestion pipeline for Lake County, Florida property,
permit, ownership, business, contractor and coordinate data. It consolidates every
source into DuckDB/Parquet, publishes each run to IPFS as immutable, CID-addressed
artifacts, and exposes the result through a hosted UI, REST API, MCP endpoint and
LLM agent so the [Roofing CRM](https://github.com/prismteam-ai/roofing-crm) can
find aged roofs and roofing permits inside a map radius. The
[original assignment brief](#original-assignment-brief) is preserved verbatim at
the end of this document.

| Where to look                                                                                                                                  | What it is                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **[Hosted UI, REST, MCP and agent](https://tf2ynypdvfkv4dqxszpkj5emjq0imyxh.lambda-url.us-east-2.on.aws/)**                                    | Live deployment; no credentials needed                                                          |
| **[Walkthrough video](docs/demo-walkthrough-20260917/walkthrough.webm)** · [recorder report](docs/demo-walkthrough-20260917/preview-demo.json) | Recorded against the hosted deployment, every beat of the demo transcript                       |
| [Artifact manifest](artifacts/manifest-20260916T181000Z.json) · [gateway verification](artifacts/verification-20260916T181000Z.json)           | Every published object with CID, size, codec and SHA-256; 41/41 verified on two public gateways |
| [Run history](artifacts/run-history.json) · [latest](artifacts/latest.json)                                                                    | Eight successful publications since 2026-09-09, all prior CIDs retained                         |
| [Runbook](docs/runbook.md) · [Deploy guide](docs/deploy.md) · [Cost model](docs/cost.md)                                                       | Operate, deploy, and what Oracle does and does not pay for                                      |
| [Delivery handoff](docs/submission-handoff-20260917.md)                                                                                        | Exact CIDs, CAR import instructions, evidence receipts                                          |

## What is loaded

Selected run `20260916T181000Z`, root CID
`bafybeigakr7d6nywkbanzmh4r7cpv7kz7qs5vxvwlxcxuovk2lobrj442u`. Every record is real
Lake County data with source provenance; nothing is fixture or synthetic.

| Dataset                                          | Source                                 |                    Records |
| ------------------------------------------------ | -------------------------------------- | -------------------------: |
| Assessed properties (owner name, mailing, value) | FL DOR NAL roll                        |                **215,806** |
| Permits, total                                   | Clermont eTRAKiT + Lake County CD Plus |                 **76,166** |
| — Clermont permits, 2015–2026, all twelve years  | Clermont eTRAKiT (HTML portal)         |                     58,495 |
| — Lake County CD Plus permits                    | CD Plus ArcGIS layer                   |                     17,671 |
| — of which literal `ROOF/REROOF`                 |                                        |                      9,969 |
| Sales                                            | FL DOR SDF (2025–2026 window)          |                     37,020 |
| Business accounts                                | FL DOR TPP                             |                 **33,346** |
| Property coordinates (joined parcel centroids)   | FL GIO parcel FeatureServer            |                **209,503** |
| Built-year roof-age proxies                      | derived                                | 169,007 (120,362 aged 15+) |
| Contractor names                                 | source-listed on Clermont permits      |                 per permit |

Permits link to parcels by folio/alternate key: 72,187 linked, 3,979 valid unlinked
(retained, not dropped). Business accounts: 2,060 matched to parcels, 31,286 valid
unmatched (retained and queryable). Duplicate entities are reconciled on stable
folio/permit/account identities; every row carries `source_system`, run id and
capture provenance.

### The Clermont permit harvest

Lake County has no countywide permit feed. The only bulk source is CD Plus (17,671
permits). The rest of the permit history lives behind the City of Clermont's
eTRAKiT portal as server-rendered HTML, one permit per page. The pipeline harvests
it politely: a durable, resumable coordinator walks the portal year by year
(twelve annual partitions, 2015–2026, roughly 66,000 requests and ~50 GB of raw
HTML end to end), rate-limited, checkpointed per partition, with a hard deadline
and cost ceiling that pause for explicit approval before continuing. Each partition
emits a signed receipt; the certified 2015–2026 baseline is materialized from those
receipts, never from a partial export. The result is a complete ten-year permit
history for Clermont — 58,495 permits with type, status, dates and source-listed
contractor — which is what makes the roofing-permit and contractor views possible
at all. See the [runbook](docs/runbook.md#durable-clermont-control-plane) and
[cost model](docs/cost.md#measured-fast-path).

## Continuous, incremental ingestion

Every stage is idempotent and windowed. A refresh pulls only records whose source
modification timestamp falls in the window, diffs them against the prior run by
row hash, and records inserts/updates/unchanged counts with timestamps in
[`run-history.json`](artifacts/run-history.json).

The most recent real refresh (`20260917T152549Z`, captured 2026-09-16 18:05 UTC)
ingested **265 new and 801 changed CD Plus permits**, producing 76,431 total
permits and a distinct new root CID
`bafybeicuvlx746twkowvsaz5g73ijajjirvxberemew747krlknfk5do7q`, while every byte of
the prior run stayed unchanged. Its primary IPFS imports are accepted; it is
promoted to `latest`/IPNS once the second pinning provider confirms retention
(the publish gate refuses to move the pointer before that). Evidence:
[integration packet](artifacts/incremental-integration-20260917T152549Z.json),
[held manifest](artifacts/manifest-20260917T152549Z.held.json).

Run history: eight successful publications between 2026-09-09 and 2026-09-16, each
with its own root CID, manifest CID and verification receipt in `artifacts/`.

## IPFS publication

CIDs are the identity of every artifact; gateway URLs are only locators.

| Item                           | Value                                                                                                                                                                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root (directory, CIDv1 base32) | `bafybeigakr7d6nywkbanzmh4r7cpv7kz7qs5vxvwlxcxuovk2lobrj442u`                                                                                                                                                                                                                   |
| Manifest (40 objects)          | `bafkreiezsu6lbe7v43vv5hq26tp2ucojuajvpntapw2rn6fhntuq3oyopm` — [Filebase](https://ipfs.filebase.io/ipfs/bafkreiezsu6lbe7v43vv5hq26tp2ucojuajvpntapw2rn6fhntuq3oyopm) · [Pinata](https://gateway.pinata.cloud/ipfs/bafkreiezsu6lbe7v43vv5hq26tp2ucojuajvpntapw2rn6fhntuq3oyopm) |
| CAR (all three directory DAGs) | `bafybeicasgbg4y75477jq73lm7rsiw4a6gcbz4yjxdy6dicv5aj2q5oriq` — 341,012,658 bytes, SHA-256 `b09b1186…4c659f`, importable by any IPFS node without re-encoding                                                                                                                   |
| IPNS                           | `k51qzi5uqu5dgd1ekyyuhwggov571fjxof2p5ef4ke7enlq60k03r47fosb2un` → resolves to the root above (sequence 14)                                                                                                                                                                     |
| Gateway verification           | [41/41 objects](artifacts/verification-20260916T181000Z.json) fetched from two public gateways this project does not operate; size and SHA-256 match the manifest                                                                                                               |
| Pinning                        | Filebase (primary) plus independent Lighthouse retention of the complete CAR and all directory roots (1,352 blocks validated)                                                                                                                                                   |

Each manifest entry carries `cid`, `name`, `size`, `codec` (`file`/`directory`) and
`sha256`. Prior CIDs are never mutated; a new run always produces a new root.

Fetch and query the dataset with nothing but `curl` and DuckDB:

```bash
ROOT=bafybeigakr7d6nywkbanzmh4r7cpv7kz7qs5vxvwlxcxuovk2lobrj442u
curl -L "https://ipfs.filebase.io/ipfs/$ROOT/coverage.json" | jq .tables.properties.rows
curl -L "https://gateway.pinata.cloud/ipfs/$ROOT/query-table.parquet" -o query-table.parquet
curl -L "https://gateway.pinata.cloud/ipfs/$ROOT/permit-table.parquet" -o permit-table.parquet
duckdb -c "SELECT count(*) FROM 'query-table.parquet' WHERE roof_age_years >= 16 AND roof_age_basis = 'built_year_proxy'"
```

## Query surface

One stateless Node process serves everything; the hosted copy runs on a
scale-to-zero Lambda and DuckDB range-reads the Parquet straight from IPFS.

- **UI** — Overview (run summary, sources, counts, publication metadata), Tenant
  (ownership locality), Business, Contractor, Search (radius + roof-age filters on a
  map), Ask (agent), SQL (read-only DuckDB explorer).
- **REST** — `/api/*`; see [`packages/server/README.md`](packages/server/README.md#rest-routes).
- **MCP** — `POST /mcp`, ten tools: `findPropertiesInRadius`, `findAgedRoofs`,
  `findOpenRoofPermits`, `queryProperties`, `getPropertyQuerySchema`,
  `listOracleProperties`, `getOracleProperty`, `getPropertyPermits`,
  `listOracleBusinessAccounts`, `getOracleDatasetInfo`.
- **Agent** — Vercel AI SDK with typed tools over the same DuckDB snapshot. Every
  property the agent lists is rendered server-side from the actual query rows, so
  the model cannot invent a parcel; when the data cannot support a conclusion it
  says so instead of guessing.

Example: five miles around `28.5494, -81.7729` (Clermont) with roof-age proxy
strictly over 15 years returns **23,696** properties, each with coordinates, the
roof-age basis and source provenance. The agent prompt from the brief — _"Which
properties in Lake County within five miles of Clermont have roofs older than 15
years?"_ — returns 25 canonical rows; in the recorded walkthrough every displayed
field was independently replayed against the hosted database.

## Acceptance criteria

| Requirement                                       | Status | Notes                                                                                                                                   |
| ------------------------------------------------- | :----: | --------------------------------------------------------------------------------------------------------------------------------------- |
| Lake County, FL as default county                 |   ✅   | FIPS 12069 throughout                                                                                                                   |
| Property records loaded                           |   ✅   | 215,806, full assessed roll                                                                                                             |
| Permit records, roofing emphasis                  |   ✅   | 76,166 incl. complete Clermont 2015–2026; 9,969 `ROOF/REROOF`                                                                           |
| Permit status, dates, duration-open signals       |   ⚠️   | Status, issued and last-modified dates retained. Sources publish no close date, so "currently open" cannot be derived (see limitations) |
| Ownership records                                 |   ✅   | Owner name and mailing address from NAL; sales from SDF                                                                                 |
| Contractor records                                |   ⚠️   | Source-listed contractor names on Clermont permits; state license verification blocked (DBPR/Sunbiz 403)                                |
| BBB ratings where publicly available              |   ❌   | BBB blocks automated access; field is `NULL`, never a fabricated score                                                                  |
| Business records                                  |   ✅   | 33,346 TPP accounts                                                                                                                     |
| Location / coordinates for radius queries         |   ✅   | 209,503 parcel centroids                                                                                                                |
| Roof age or proxy, configurable threshold         |   ✅   | Built-year proxy, threshold configurable, default 15                                                                                    |
| Duplicate reconciliation, provenance              |   ✅   | Stable identities per source; `source_system` + run id on every row                                                                     |
| Continuous / incremental, run history with deltas |   ✅   | Windowed idempotent refresh, 265/801 real delta, eight-run history                                                                      |
| No default Oracle infrastructure cost             |   ✅   | Immutable files on IPFS + consumer-side DuckDB; hosted demo is optional and scale-to-zero                                               |
| IPFS + DuckDB + MCP + agent + UI                  |   ✅   | All live at the hosted URL                                                                                                              |
| CIDv1, manifest with cid/name/size/codec/digest   |   ✅   | 40-object manifest per run                                                                                                              |
| IPNS name + resolved CID                          |   ✅   | Recorded in `latest.json`                                                                                                               |
| Immutable republish, prior CIDs retained          |   ✅   | New root per run; history keeps all                                                                                                     |
| CAR for directory roots                           |   ✅   | 341 MB multi-root CAR, public by CID                                                                                                    |
| Two independent public gateways, bytes match      |   ✅   | 41/41 via Filebase and Pinata (ipfs.io / dweb.link rate-limit datacenter IPs)                                                           |
| Radius query                                      |   ✅   | UI, REST, MCP, agent                                                                                                                    |
| Roofs older than threshold                        |   ✅   | 23,696 in the sample radius                                                                                                             |
| Open roofing permits, long-open                   |   ⚠️   | Historical roofing permits with status/dates are queryable; current-open status is not in any source                                    |
| Permit details with contractor and BBB            |   ⚠️   | Contractor yes (Clermont); BBB unavailable                                                                                              |
| Ownership unchanged > 10 years                    |   ❌   | DOR publishes only the current roll and a 2025–2026 sales window                                                                        |
| Regional / out-of-area owners                     |   ✅   | Owner-mailing locality in Tenant view and agent                                                                                         |
| Source-backed answers                             |   ✅   | Rows rendered from query results with provenance; agent abstains otherwise                                                              |
| Demo: UI, agent, cost, public CID retrieval       |   ✅   | [Walkthrough](docs/demo-walkthrough-20260917/walkthrough.webm) against the hosted deployment                                            |

## Known limitations

These are properties of the public sources, not of the pipeline, and each is
surfaced in the UI and agent rather than hidden.

1. **Open-permit status and duration.** Neither Clermont eTRAKiT nor CD Plus
   publishes a close/final date. The pipeline stores every status and date the
   source provides; the UI and agent show historical `ISSUED` roofing permits with
   issue dates but refuse to label a permit "currently open" or compute an open
   duration, because that would be a guess.
2. **Roof age is a built-year proxy.** No source publishes roof replacement dates.
   Age is `current year − year built`, labelled low-confidence.
3. **BBB ratings** are gated behind BBB's anti-automation policy (HTTP 403 on every
   permitted route). The column exists and is `NULL`.
4. **Ten-year ownership tenure** cannot be established: the DOR publishes only the
   current roll and a 2025–2026 sales window.
5. **Contractor identity** is the name string on the Clermont permit. DBPR license
   and Sunbiz entity lookups return 403 to automated access, so names are not
   verified against a legal entity.
6. **County completeness.** Fifteen permitting jurisdictions are catalogued in
   [`lake-sources.yaml`](pipeline/docs/lake-sources.yaml). Clermont and the county
   CD Plus layer are the two with bulk-accessible history; the other thirteen sit
   behind CAPTCHAs, bot challenges or logins, or offer no public historical search.
   A public-records request route is documented for each.
7. **Incremental run promotion.** The `20260917T152549Z` refresh is published to the
   primary provider and awaits second-provider retention before the IPNS pointer
   moves.

## Run and verify locally

Node 22.18+ (below 23) and pnpm 10.

```bash
pnpm install
pnpm run build
pnpm run start            # UI + REST + MCP on http://localhost:8787
```

Point it at any published run with `ORACLE_PARQUET_URL=https://ipfs.filebase.io/ipfs/<rootCid>/query-table.parquet`;
set `OPENAI_API_KEY` to enable the agent. Full configuration in
[`packages/server/README.md`](packages/server/README.md#configuration).

```bash
pnpm run typecheck && pnpm run lint && pnpm run format:check
pnpm run test              # app: 677 unit + 125 responsive + 20 recorder tests
npm test --prefix pipeline # pipeline: 1,135 tests
pnpm --dir infra run synth
```

CI on the PR head: [passing](https://github.com/rarcifa/oracle-property-intelligence-platform-pipeline-lake-fl/actions).

## Cost model

The source of truth is a set of immutable files on IPFS. Anyone can query them with
DuckDB from a laptop, a browser or an MCP process; Oracle runs no database.

| Component   | Default operator                          | Oracle fixed cost |
| ----------- | ----------------------------------------- | ----------------: |
| Data        | Immutable CIDs on IPFS                    |              none |
| Query       | Consumer-side DuckDB over Parquet         |              none |
| UI / MCP    | Static SPA + stateless process            |              none |
| Ingestion   | On-demand (laptop, CI, or approved Batch) | none between runs |
| Pinning     | Two providers (Filebase, Lighthouse)      |    plan-dependent |
| Hosted demo | Optional Lambda, scale-to-zero            |   usage-dependent |

Details, measured stage timings and the Clermont harvest budget are in
[docs/cost.md](docs/cost.md).

## Scope and references

This repository is the data pipeline. The Roofing CRM UI, map-pin interaction
design and lead outreach live in
[roofing-crm](https://github.com/prismteam-ai/roofing-crm). Built with the
[Soofi XYZ Team Kit](https://github.com/soofi-xyz/soofi-xyz-team-kit) agents and
skills (see [AGENTS.md](AGENTS.md)) following
[Elephant Oracle](https://github.com/elephant-xyz/skills) publication conventions.

---

## Original assignment brief

### Context

This repository is the **data gathering and ingestion pipeline** that supplies the [Roofing CRM & Lead Identification UI](https://github.com/prismteam-ai/roofing-crm). The CRM helps roofing companies explore properties in their service area, identify aging roofs and open roofing permits, and turn those signals into leads. This pipeline story covers collecting, loading, reconciling, and exposing the underlying property and permit datasets; the CRM UI/workflow itself is out of scope here.

The Oracle ingestion pipeline has been started, but the full **Lake County, FL** dataset has not been completely uploaded, reconciled, or demonstrated. The infrastructure must be designed so Oracle does not carry ongoing infrastructure cost by default. For this candidate exercise, the candidate acts as both Oracle and builder: they are responsible for completing the pipeline and proving the low-cost infrastructure approach.

The pipeline must be continuous and incremental (ongoing ingestion of new and changed records over time) and must publish eligible data artifacts to Elephant IPFS (the Elephant protocol’s decentralized storage layer, following Lexicon / elephant-cli / Filebase+IPNS conventions used by the Elephant oracle skills).

Published artifacts must remain independently retrievable from the public IPFS network after the candidate’s local environment, demo session, and any single pinning vendor are gone. **Content identifiers (CIDs) are the durable identity of each artifact.** A vendor HTTP gateway URL is a convenience locator, not the artifact.

In addition to standard property intelligence, the pipeline must surface signals relevant to **roofing lead generation**, including roof age, open roofing permits (especially long-open permits), contractor identity, BBB rating scores where available, ownership/contact fields where available, and accurate property coordinates for radius-based search.

### Description

Complete the Oracle pipeline by loading all available Lake County, FL property, permit, ownership, business, contractor, location, and public-source data into an MCP-ready database. Use IPFS and DuckDB to minimize Oracle-hosted infrastructure costs while enabling UI and agent access to answer property intelligence questions that support the roofing CRM—especially aged-roof and open-permit lead discovery within a map radius.

The pipeline must demonstrate that data is ingested on an ongoing basis (not a one-shot bulk load): support incremental / windowed refreshes, preserve run history with record deltas and timestamps, and re-publish updated artifacts to Elephant IPFS as **new immutable CIDs** (do not mutate a previously published CID).

### Acceptance Criteria

### Geography & coverage

- Target **Lake County, FL** as the default and primary county for ingestion and demos.

### Data loading

- Run the Oracle pipeline until all available county data is uploaded.
- Load available property records into the database.
- Load available permit records into the database, with emphasis on **roofing-related permits**.
- Preserve permit status, open/close dates (or equivalent), and duration-open signals so long-open permits can be identified.
- Load available ownership records into the database.
- Load available contractor records into the database.
- Load available BBB / contractor rating scores where publicly available.
- Load available business records into the database.
- Load available location and coordinate data into the database (required for GPS/pin-drop radius queries in the CRM).
- Capture roof age or best-available proxies (e.g., year built, last roofing permit/completion date) so properties with roofs older than a configurable threshold (default suggestion: **15 years**) can be queried.
- Reconcile duplicate entities across all uploaded datasets.
- Preserve source provenance for uploaded records.
- Design and implement the pipeline as continuous / incremental:
  - Support ongoing ingestion of new and changed records (scheduled or on-demand refreshes, change detection or bounded windows, idempotent steps).
  - Maintain a visible history of pipeline runs (timestamps, source list, record counts, deltas, any source limitations).
  - Demonstrate that data continues to be ingested and published over time (multiple runs or simulated ongoing updates).

### Infrastructure & access

- Optimize pipeline performance where feasible.
- Identify slow source sites or constrained data sources.
- Document pipeline speed limitations and source constraints.
- Design the infrastructure so Oracle does not carry ongoing infrastructure cost by default.
- Use IPFS for decentralized storage of eligible dataset artifacts.
- Use DuckDB for local or portable analytical querying.
- Structure the database to support MCP access.
- Enable agent access to query the database.
- Provide a UI for exploring the uploaded data.

### IPFS publication

- Treat IPFS **CIDs** as the durable identity of published artifacts. Do not treat a vendor-specific HTTP URL as the source of truth.
- Prefer **CIDv1** (base32) for every published object.
- Keep published bytes **retrievable from the public IPFS network**, not only from a private node, authenticated gateway, vendor dashboard, or laptop that is running during the demo.
- Publish a machine-readable **artifact manifest** (JSON) for each pipeline run. Include every eligible object (query table, coverage, indexes, sample extracts, and any directory roots) with at least:
  - `cid`
  - logical `name` / path
  - `size` in bytes
  - IPFS codec (`file` vs `directory`)
  - content digest (e.g. SHA-256 of the raw bytes, or equivalent)
  - optional provider `origins` (multiaddrs) if a candidate-operated node is still serving the blocks
- If IPNS is used, record both the IPNS name and the **resolved CID** for that run. IPNS is a pointer; the CID is the snapshot.
- On incremental republish, keep prior CIDs immutable. New data produces a new CID. Run history must retain previous CIDs.
- For directory artifacts, also publish a **CAR** of the DAG rooted at that CID so the snapshot can be imported by any IPFS node without re-encoding.
- Demonstrate that each listed CID can be fetched from **at least two independent public gateways** that this environment does not operate (for example `https://ipfs.io/ipfs/<cid>` and `https://dweb.link/ipfs/<cid>`), and that the retrieved bytes match the manifest size/digest.
- Include the artifact manifest (and CARs, if any) in the repository or demo packet so a third party can fetch the dataset by CID after the candidate environment is gone.

### Roofing CRM–supporting queries

- Support radius-based property identification using coordinates (around a GPS point or map pin).
- Support questions about properties with roofs older than 15 years (or a configurable age threshold).
- Support questions about properties with **open roofing permits**, including those that have remained open for many years.
- Support returning permit details with contractor name and BBB rating score where available.
- Support questions about properties that have not exchanged ownership in more than 10 years.
- Support questions about properties with regional (or out-of-area) owners.
- Return source-backed answers where source data is available.

### Demonstration

- Demonstrate the uploaded dataset through the UI.
- Demonstrate the uploaded dataset through an agent query aligned to roofing lead discovery.
- Demonstrate that Oracle can operate without carrying the infrastructure cost.
- Demonstrate public, CID-addressed IPFS publication using the artifact manifest and independent gateway retrieval (not a private-only locator).
- Confirm the candidate fulfilled both Oracle and builder responsibilities for this milestone.
- Pass the demo using real uploaded Lake County records.

### Demo Transcript

- Presenter: “I will demonstrate that the Oracle pipeline has loaded the available dataset for Lake County, Florida, that the data is queryable through DuckDB, that eligible artifacts are stored on IPFS as content-addressed snapshots, and that both the UI and agent can answer property intelligence questions that support roofing lead generation.”
- Presenter: “First, I am opening the pipeline run summary.”
  - Expected Result: The system displays the completed pipeline run, source list, county coverage, record counts, timestamps, and any documented source limitations.
- Presenter: “Show the total uploaded records by source.”
  - Expected Result: The system shows uploaded property, permit, ownership, contractor (with BBB rating where available), business, and coordinate records with collection timestamps and provenance.
- Presenter: “Now I am opening the DuckDB-backed query layer.”
  - Expected Result: The system confirms that the loaded data is available for structured querying without requiring Oracle-hosted database infrastructure.
- Presenter: “Show the published artifact manifest for this run.”
  - Expected Result: A JSON (or equivalent) listing every eligible artifact with CID, size, logical name, codec, and digest. Gateway URLs, if shown, are derived from those CIDs. An IPNS name, if used, is shown together with the resolved CID.
- Presenter: “Retrieve one published artifact by CID from a public gateway that this environment does not operate, then again from a second independent public gateway.”
  - Expected Result: Both fetches succeed and the bytes match the manifest size/digest. Serving the object only from a private, local, or authenticated gateway is a fail.
- Presenter: “Show that a later incremental publish produced a new CID without mutating the previous one.”
  - Expected Result: The prior CID still resolves; the new run has a distinct CID; IPNS (if used) now points at the new CID; both CIDs appear in run history. A CAR is available for any directory root.
- Presenter: “Using the UI, show properties within a sample radius that have roofs older than 15 years.”
  - Expected Result: Matching properties are returned with roof-age basis, coordinates, and source provenance.
- Presenter: “Show properties in that area with open roofing permits, prioritizing permits that have remained open for many years, including contractor and BBB rating where available.”
  - Expected Result: Results include permit status/open duration, contractor identity, BBB score when present, and clear source backing.
- Presenter: “Now I am asking the same type of questions through the agent.”
  - Agent Prompt: “Which properties in Lake County within five miles of [city xyz] have roofs older than 15 years?”
    - Expected Result: The agent returns matching properties, explains the reasoning, and includes source-backed evidence.
  - Agent Prompt: “Which properties near that area have open roofing permits that have been open for many years, and who is the listed contractor?”
    - Expected Result: The agent returns a filtered list with permit age/open duration, contractor details, BBB rating when available, and clearly identifies any assumptions or missing data.
- Presenter: “Finally, I will show that the system is MCP-ready.”
  - Expected Result: The system demonstrates an MCP-ready interface or documented MCP-compatible query structure that agents and the roofing CRM can use without changing the data model.

### Out of Scope

- Roofing CRM UI, map pin/GPS interaction design, and lead outreach workflows (covered in [roofing-crm](https://github.com/prismteam-ai/roofing-crm)).
- Live outbound messaging to property owners.

### Reference

- [Roofing CRM & Lead Identification UI](https://github.com/prismteam-ai/roofing-crm)
- [Soofi XYZ Team Kit](https://github.com/soofi-xyz/soofi-xyz-team-kit)
- [Elephant Oracle Skills](https://github.com/elephant-xyz/skills)
