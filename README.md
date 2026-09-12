# Oracle Property Intelligence Platform Pipeline - Lake County, FL

## Implementation status — 2026-09-11

This repository is **salvageable and implemented**. An Arceus-routed candidate audit
classified the starting point as a 72/100 Partial Pass: the core architecture and public
runtime were real, but the submission exposed only property-level permit aggregates,
the completed Clermont contractor harvest had not reached the published runtime, and
several tests and handoff documents had drifted.

The repair keeps the working architecture and closes the local implementation gaps. It
does **not** silently publish owner/address data or move IPNS. The repaired run is built,
schema-gated and CID-addressed locally; a fresh public release and runtime deployment
remain explicit operator actions.

Agents and skills are supplied globally by the official Soofi Codex plugin, not copied
into this repository. `codex plugin list` must show
`soofi-xyz-team-kit@soofi-xyz-team-kit` as installed and enabled. The repository's
Lake-specific implementation lives in `pipeline/`, and Codex project guidance lives in
[`AGENTS.md`](AGENTS.md).

| State                   | Run                | Properties |                                       Permit rows |                       Contractor rows | Publication                            |
| ----------------------- | ------------------ | ---------: | ------------------------------------------------: | ------------------------------------: | -------------------------------------- |
| Public runtime          | `20260910T225242Z` |    215,806 |                17,671 source rows / 17,457 linked |               0 in the deployed table | Public IPFS, independently verified    |
| Repaired local snapshot | `20260911T131000Z` |    215,806 | 21,732 total / 21,221 linked / 511 valid unlinked | 3,634 permit rows; 996 distinct names | Dry-run only; no upload or IPNS change |

- Public UI, REST, MCP and agent runtime:
  [Lake County Oracle](https://tf2ynypdvfkv4dqxszpkj5emjq0imyxh.lambda-url.us-east-2.on.aws/)
- Current public root CID:
  `bafybeigpkklcelrvukkwvor42wfmibmvwuveufwjspsumgmpbx3r26iowy`
- Repaired local dry-run root CID:
  `bafybeih5xrlpzdvjoky75aq7j2cad36dnnzec4suqiwboy3ucayjgyeqnq`
- Repaired local manifest CID:
  `bafkreiaqiwvmkfgz7yziuxeurgb4jpecbzwh57rj3qbzyjszsv2ltuhmwy`

The dry-run CIDs identify local build output only until a human approves the new public
release. See [the quality audit](docs/quality-audit.md), [runbook](docs/runbook.md),
[deployment guide](docs/deploy.md), [observability handoff](docs/observability-handoff.md), [cost model](docs/cost.md), and
[demo script](docs/demo-script.md).

### What is implemented

- A 215,806-row, one-row-per-property DuckDB/Parquet table with property, ownership,
  sale-window, roof-age, location, business and permit summary fields.
- A separate 21,732-row `permit-table.parquet` at permit grain. It preserves permit
  identity, status, applied/approved/issued/completed/modified dates, duration open,
  roofing classification, contractor/license, BBB field, source URL, jurisdiction, and
  linkage state. The 511 records that do not join the assessed roll remain queryable.
- Lake County CD Plus ingestion plus a completed, resumable **permit-year 26** Clermont
  eTRAKiT harvest: 4,132 enumerated, 4,061 achievable and extracted, and 71 permanently
  excluded by the prior local no-parcel-key rule. The repaired harvester preserves those
  public details as valid-unlinked records on the fresh full run. The repository also
  implements partitioned, fenced, digest-bound orchestration and immutable last-good
  materialization for permit years 15–26, but that full historical capture has not been
  authorized, run, or certified.
- Incremental/windowed source refreshes, idempotent job artifacts, record-delta history,
  immutable per-run CIDs, CIDv1 manifests, CAR output, predecessor-fenced IPNS readback,
  and independent gateway verification. A new public release additionally requires a
  second non-Filebase pin and a one-use Ed25519 authorization for the exact target.
- One TypeScript runtime exposing the same DuckDB data through REST, nine MCP tools, an
  OpenAI-backed Vercel AI SDK agent, and the React UI. Browser mode range-reads the two Parquet files
  directly from IPFS through DuckDB-WASM; server mode is the fallback.
- Read-only SQL controls, bounded results and memory, external-access lockdown after
  materialization, strict MCP arguments, source provenance, and explicit gated/partial
  enrichment notices.
- Local key-free RAG over project documentation for coverage, provenance, derivation and
  source-limitation questions.

### Acceptance status

| README requirement                            | Status                          | Evidence / boundary                                                                                                                                                                                                        |
| --------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lake County default geography                 | Pass                            | County key `lake`, FIPS `12069`; 215,806 assessed parcels                                                                                                                                                                  |
| Property, ownership and coordinates           | Pass                            | Full DOR roll; 209,503 parcels have 2025 GIO centroids                                                                                                                                                                     |
| Permit records and long-open signals          | Pass locally                    | 21,732 permit-grain rows; 5,752 open and 3,681 roofing rows                                                                                                                                                                |
| Contractor identity                           | Partial by source               | Clermont only: 3,634 named permit rows, 996 distinct contractors; other jurisdictions do not publish an accessible field                                                                                                   |
| BBB rating                                    | Honest source limitation        | 0 published ratings; the default BBB route returned 403, one prohibited browser-fingerprint spoof returned 200, and no approved official-API harvest was run                                                               |
| Business records                              | Pass with measured match limits | 33,346 DOR TPP accounts; 2,060 address matches attributed across 2,726 properties                                                                                                                                          |
| Roof age / 15-year query                      | Pass with explicit basis        | 117,579 properties meet the default threshold; basis is completed permit, issued permit, or year built                                                                                                                     |
| More than 10 years without ownership exchange | Unsupported by available source | The public DOR material covers only the current 2025–2026 sale window; the system returns the narrower `no_recorded_sale_in_dor_window` signal and does not invent tenure                                                  |
| Radius and out-of-area-owner queries          | Pass                            | Great-circle filtering over published coordinates; owner locality is derived and source-labelled                                                                                                                           |
| Continuous/incremental operation              | Implemented; baseline pending   | Windowed refresh, resumable partition plans, immutable last-good restore, seven public runs, deltas and immutable run identities; scheduled clean runners fail until an external certified Clermont baseline is configured |
| IPFS manifest, CIDv1, CAR, two gateways       | Pass for current public run     | Files in `artifacts/`; repaired snapshot passed local content gates but still needs an independent second pin, exact approval, upload and public verification                                                              |
| DuckDB, REST, MCP, agent and UI               | Pass                            | Public runtime linked above; local MCP now also exposes full permit rows                                                                                                                                                   |

“All available” is a completion target, not a claim about the repaired snapshot. The
current local snapshot contains Clermont permit year 26 only. The portal's known
searchable history spans permit years 15–26, so years 15–25 remain a hard blocker for a
complete-source claim even though the durable capture/materialization machinery is now
implemented. The phrase also does not mean bypassing access controls or converting an
unavailable field into a false zero. Jurisdiction-by-jurisdiction boundaries and named records-request paths are in
[lake-sources.yaml](pipeline/docs/lake-sources.yaml).

### Query the repaired tables locally

```bash
# Property grain
duckdb -c "SELECT count(*) FROM 'pipeline/data/artifacts/publish/lake/query-table.parquet'"

# Permit grain, including records that do not join the assessed roll
duckdb -c "SELECT permit_number, permit_status, days_open, contractor_name, bbb_rating, source_url
FROM 'pipeline/data/artifacts/publish/lake/permit-table.parquet'
WHERE is_roofing AND is_open
ORDER BY days_open DESC NULLS LAST
LIMIT 25"
```

After `pnpm install`, the normal repository gates are:

```bash
pnpm run build
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm run test
npm test --prefix pipeline
pnpm --dir infra run synth
```

The publication workflow is human-gated. A dry-run may compute the DAG, manifest and
CAR; a live publish/repoint must follow the approval procedure in the runbook.

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
