# Oracle Property Intelligence Pipeline — Lake County, FL

Continuous ingestion of Lake County, Florida property, permit, ownership, business and
contractor data into a **DuckDB-queryable, MCP-ready, CID-addressed** dataset on public
IPFS, with a UI and an agent for roofing-lead discovery.

Built by driving the **soofi-xyz team kit**: routed by `arceus`, executed by `oracle`
through `onboard-county` and its stage skills against the kit's bundled ingestion runtime.
Where the assignment needs something no kit skill covers — CAR files, CIDv1, per-run
artifact manifests, multi-gateway verification, run history with deltas — the kit's nearest
neighbour was extended in its own conventions. Every such decision is listed in
[`.claude/skills/use-oracle/runtime/docs/lake-kit-deviations.md`](.claude/skills/use-oracle/runtime/docs/lake-kit-deviations.md).

|                           |                                                                                                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Newest verified run**   | [`artifacts/latest.json`](artifacts/latest.json) — root CID, manifest CID, IPNS name, verified gateways                                                           |
| **Run history**           | [`artifacts/run-history.json`](artifacts/run-history.json) — every run with sources, counts, deltas, limitations, CIDs                                            |
| **Artifact manifest**     | `artifacts/manifest-<run>.json` — cid, name, size, codec, sha256 per object                                                                                       |
| **Gateway evidence**      | `artifacts/verification-<run>.json` — which gateways returned matching bytes                                                                                      |
| **Source catalog**        | [`docs/lake-sources.yaml`](.claude/skills/use-oracle/runtime/docs/lake-sources.yaml) · [findings](.claude/skills/use-oracle/runtime/docs/lake-county-findings.md) |
| **Runbook · cost · demo** | [runbook](docs/runbook.md) · [cost](docs/cost.md) · [demo script](docs/demo-script.md)                                                                            |

## What is loaded

| Table                                                         | Rows                           | Source                                                                                |
| ------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------- |
| properties (one row per assessed parcel, 59 columns)          | **215,806**                    | FL DOR NAL 2026P                                                                      |
| permits (3,312 roofing · 3,753 open · 247 open roofing)       | **17,671**                     | Lake County CD Plus, windowed on `Permit_LastModDate`                                 |
| permits linked to an assessed parcel · valid unlinked         | 17,457 · **214**               | 119 permit parcel keys are absent from the roll; the records are counted, not dropped |
| coordinates                                                   | **209,503** (97.1%)            | FL GIO parcel centroids 2025                                                          |
| business accounts with NAICS (1,883 construction, 44 roofing) | **33,346**                     | FL DOR TPP 2026P                                                                      |
| sale records                                                  | **37,020** over 30,977 parcels | FL DOR SDF 2026P                                                                      |
| distinct owner names                                          | **168,315**                    | FL DOR NAL                                                                            |

Derived lead signals, all queryable:

| Signal                                             | Count   |
| -------------------------------------------------- | ------- |
| Roof age known                                     | 169,028 |
| Roofs 15 years or older                            | 117,605 |
| Roof age dated from a completed roofing permit     | 2,646   |
| Properties with an open roofing permit             | 226     |
| Properties with a permit open more than five years | 20      |
| Out-of-state owners                                | 20,285  |
| No recorded sale in the DOR window                 | 185,711 |

## Architecture

```
bulk sources (no scraping fleet: every source is a download or a bounded Esri page walk)
  ├─ FL DOR NAL / SDF / TPP  ── 42 s
  ├─ FL GIO parcel centroids ── 210,935 rows, ids-only + OBJECTID ranges, ~10 s
  └─ Lake CD Plus permits    ── 17,915 features, 6.5 s, windowed for incremental runs
        │
  seed  ├─ data/seeds/lake.csv, 215,806 rows, no PII, reconciliation enforced
        │
  DuckDB├─ join → 59-column query table → gate: rows == distinct folio, 0 null folios
        │
publish ├─ UnixFS DAG built and hashed LOCALLY → CIDv1 base32 → CAR
        ├─ CAR imported to Filebase with x-amz-meta-import: car, pinning the exact DAG
        ├─ IPNS re-pointed, then READ BACK and compared to the published root
        └─ every listed CID fetched from independent public gateways, bytes and sha256 compared
        │
  read  └─ DuckDB range-reads the Parquet by CID. No server in the read path.
```

## Quick start

```bash
(cd .claude/skills/use-oracle/runtime && npm ci)
npm test --prefix .claude/skills/use-oracle/runtime
python3 .claude/skills/use-oracle/scripts/validate-county-readiness.py \
  .claude/skills/use-oracle/runtime/docs/lake-sources.yaml
```

Full pipeline commands are in [`docs/runbook.md`](docs/runbook.md).

## Fetch the data with nothing but curl

```bash
ROOT=$(jq -r .rootCid artifacts/latest.json)
curl -sL "https://ipfs.filebase.io/ipfs/$ROOT/coverage.json" | jq .tables.properties.rows
curl -sL "https://gateway.pinata.cloud/ipfs/$ROOT/query-table.parquet" -o query-table.parquet
duckdb -c "SELECT count(*) FROM 'query-table.parquet' WHERE roof_age_years >= 15 AND open_roofing_permit_count > 0"
```

## Two runs, two CIDs, prior data untouched

| Run                | Mode        | Root CID            | Property deltas   | Gateways verified |
| ------------------ | ----------- | ------------------- | ----------------- | ----------------- |
| `20260909T182356Z` | full        | `bafybeigb3g…rltee` | 215,806 inserted  | 5                 |
| `20260909T185056Z` | incremental | `bafybeiay65…z33q`  | 215,806 unchanged | 2                 |

The IPNS name resolves to the newest run; every run's own root CID is permanent. Run one's
root still resolves after run two republished, and the run before both of them, published
earlier the same day, was independently re-checked from three gateways and returns a
byte-identical manifest — that evidence is in `artifacts/prior-publication.json`.

The incremental run's deltas are genuinely zero, and that is reported rather than dressed
up. It re-fetched the 304 permits whose `Permit_LastModDate` had moved in the preceding four
days and merged them by permit number, which collapsed 244 duplicate feature rows but
changed no property-level value. A delta appears when a permit changes status, a roof gets a
new completion date, or the DOR publishes a new roll. The mechanism is exercised and the
result is honest: nothing that this pipeline measures had changed yet.

## Known limitations, stated rather than hidden

These are in `coverage.json` inside every published run, and in the source catalog.

- **The county permit layer is a rolling 365-day window, not an archive.** `Permit_LastModDate`
  spans one year and only 846 of 17,671 permits were issued before 2024-09-09. Deep permit
  history is not available from it; incremental runs accumulate history going forward.
- **It covers unincorporated Lake County only.** A spatial test puts 45 of 17,915 features
  inside any of the 14 municipal boundaries, and those are county-owned facilities. Each
  municipality runs its own system; 13 of 14 are blocked, unavailable or manual-only, and
  each has a named records-request recipient in the catalog. Exactly one, Clermont, has an
  open portal, and it is catalogued as discovered but not yet harvested.
- **Contractor identity and BBB ratings are not published.** Contractor of record lives on
  county permit detail pages behind a Cloudflare managed challenge covering the whole
  `lakecountyfl.gov` estate; `bbb.org` answers 403. Both are real columns that stay null,
  with the reason in `enrichment_status`. Nothing is invented.
- **Ten-year ownership tenure cannot be proven.** Only the current DOR roll is published and
  it carries 2025-2026 sales; the historical DOR map-data files back to 2005 carry parcel
  geometry only, which was verified by downloading the 2010 file and reading its two-field
  attribute table. `no_recorded_sale_in_dor_window` is a lower bound, not a tenure claim.
- **Coordinates come from the 2025 centroid release against the 2026 roll**, so 4,871
  parcels (2.26%) publish with null coordinates rather than being dropped.

## What is not proven yet

Three things are implemented and typecheck but have not been exercised, and they are listed
here rather than counted as working.

- **The chat agent has never called a model.** No `ANTHROPIC_API_KEY` was available in this
  environment. The Vercel AI SDK path with its five Zod-schema tools and its citation
  collector is written, and only the "no key returns 503" branch is test-covered. Export a
  key and run it once before relying on it.
- **DuckDB-WASM has never run in a real browser.** The mechanism is verified as far as it can
  be without one: `ipfs.filebase.io` returns HTTP 206 with permissive CORS and an exposed
  `Content-Range` for the 20 MB Parquet, and DuckDB over HTTPFS opened that exact gateway URL,
  passed the 59-column schema gate and returned 215,806 rows. The in-browser bootstrap itself
  is untested. It falls back to the server API and shows the reason, so a failure degrades
  rather than breaks.
- **Two groupings differ between the browser and server paths.** The out-of-state owner
  ranking and the business totals are computed separately in each, which is the one place the
  two could disagree.

There is also no hosted runtime, no pull request and no demo video, because none of those
were authorised.

## Team-kit usage

`arceus` routed the work; `oracle` drove `onboard-county`, `county-discovery`,
`county-readiness-preflight`, `county-seed-data`, `county-permit-adapter`,
`county-ingest-run`, `county-open-data-publish` and `county-query-table-publish`;
`metagross` with `build-frontend-backends` built the application; `apply-engineering-guidelines`
applies throughout. The readiness validator is a hard gate and passes on all five gates.
Deviations, including the stack question that had to be put back to the operator because the
bundled runtime contains no Restate stack, are documented rather than glossed.
