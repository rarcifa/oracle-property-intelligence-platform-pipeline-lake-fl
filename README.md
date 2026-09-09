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
| **Live runtime**          | <https://tf2ynypdvfkv4dqxszpkj5emjq0imyxh.lambda-url.us-east-2.on.aws/> — UI, REST API, MCP and agent on one Lambda Function URL in `us-east-2`                   |
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

Derived lead signals, all queryable. Every figure below is the value in `coverage.json`
inside the published run, not a number typed by hand:

| Signal                                             | Count   |
| -------------------------------------------------- | ------- |
| Roof age known                                     | 169,028 |
| Roofs 15 years or older                            | 117,605 |
| Roof age dated from a completed roofing permit     | 2,646   |
| Properties with an open roofing permit             | 226     |
| Properties with a permit open more than five years | 20      |
| Out-of-state owners                                | 20,236  |
| No recorded sale in the DOR window                 | 184,829 |

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

The application's own suite runs from the repo root. 50 of the 212 tests exercise the
query layer against a real 215,806-row table rather than a fixture, so they skip unless one
is reachable; point them at the published run to run everything:

```bash
pnpm install && pnpm run build
ORACLE_PARQUET_URL="https://ipfs.filebase.io/ipfs/$(jq -r .rootCid artifacts/latest.json)/query-table.parquet" \
  pnpm run test:unit          # 212 passed
```

Full pipeline commands are in [`docs/runbook.md`](docs/runbook.md).

## Fetch the data with nothing but curl

```bash
ROOT=$(jq -r .rootCid artifacts/latest.json)
curl -sL "https://ipfs.filebase.io/ipfs/$ROOT/coverage.json" | jq .tables.properties.rows
curl -sL "https://gateway.pinata.cloud/ipfs/$ROOT/query-table.parquet" -o query-table.parquet
duckdb -c "SELECT count(*) FROM 'query-table.parquet' WHERE roof_age_years >= 15 AND open_roofing_permit_count > 0"
```

## Or hit the deployed runtime

```bash
U=https://tf2ynypdvfkv4dqxszpkj5emjq0imyxh.lambda-url.us-east-2.on.aws
curl -s "$U/api/health"                                    # propertyCount 215806, runId, rootCid
curl -s "$U/api/stats" | jq .stats.properties              # 215806
curl -s "$U/mcp" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools|length'   # 8
curl -s "$U/api/sql" -H 'content-type: application/json' \
  -d '{"sql":"SELECT * FROM read_text(\'/etc/passwd\')"}' | jq .error              # sql_rejected
```

The last call is the one that matters: an open SQL endpoint over an engine with filesystem
access is an arbitrary-file-read primitive, and this one was exactly that until it was fixed.

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
- **Coordinates come from the 2025 centroid release against the 2026 roll**, so 6,303
  parcels (2.92%) publish with null coordinates rather than being dropped. A separate
  figure, the 2.26% in the readiness exception, measures something else: the gap between
  the 210,935-row GIS release and the 215,806-row assessed roll. The two are easy to
  conflate and an earlier draft of this file did exactly that.

## What is not proven yet

One thing is implemented and typechecks but has not been exercised, and it is listed here
rather than counted as working.

- **The chat agent has never called a model.** No `ANTHROPIC_API_KEY` was available in this
  environment. The Vercel AI SDK path with its five Zod-schema tools and its citation
  collector is written, and only the "no key returns 503" branch is test-covered. Export a
  key and run it once before relying on it.

Two items that were listed here have since been exercised against the deployed runtime and
are no longer open:

- **DuckDB-WASM now runs in a real browser.** Chromium loads the deployed app, the mode pill
  reads "Browser DuckDB-WASM · range-reading IPFS", every view renders from the Parquet
  range-read straight off `ipfs.filebase.io`, and the console is clean. It still falls back to
  the server API and shows the reason, so a failure degrades rather than breaks.
- **The browser and server paths agree.** They were compared figure by figure on the deployed
  runtime: business totals (2,726 properties with an account, 4,451 accounts) and the by-city
  ranking, owner posture (50,010 out of county, 20,236 out of state, 184,829 with no sale on
  the roll) and all seven roof-age bands are identical in both.

Fixing the browser path is what surfaced a real bug, now fixed: DuckDB returns `sum()` over an
integer column as HUGEINT, Arrow carries that as a Decimal128, and the UI decoded it with
`Array.from`. "Permit records joined" and "Roofing permit records" rendered as an em-dash in
the browser while the REST API answered 17,457 and 3,256 for the same SQL, and the SQL console
printed `[17457, 0, 0, 0]`. Both now read correctly.

The hosted runtime now exists and is exercised above. It did not on the first attempt: the
deploy succeeded and every route answered 502, because DuckDB resolves extensions under
`$HOME/.duckdb/extensions/` and Lambda sets no `HOME`. `httpfs` is not statically linked, so
it had never been shipped in the bundle at all and had only ever loaded from the developer's
own home directory. The bundle now ships it and the stack points DuckDB at it.

There is still no pull request and no demo video, because neither was authorised.

## Team-kit usage

`arceus` routed the work; `oracle` drove `onboard-county`, `county-discovery`,
`county-readiness-preflight`, `county-seed-data`, `county-permit-adapter`,
`county-ingest-run`, `county-open-data-publish` and `county-query-table-publish`;
`metagross` with `build-frontend-backends` built the application; `apply-engineering-guidelines`
applies throughout. The readiness validator is a hard gate and passes on all five gates.
Deviations, including the stack question that had to be put back to the operator because the
bundled runtime contains no Restate stack, are documented rather than glossed.
