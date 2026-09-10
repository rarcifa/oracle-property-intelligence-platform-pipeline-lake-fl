# Oracle Property Intelligence Pipeline — Lake County, FL

Continuous ingestion of Lake County, Florida property, permit, ownership and business data
into a **DuckDB-queryable, MCP-ready, CID-addressed** dataset on public IPFS, with a UI and
an agent for roofing-lead discovery.

Contractor identity and BBB reputation are **not** in it. Both are gated at source behind
HTTP 403 and are published as real columns that stay null, with the reason attached — see
[Known limitations](#known-limitations-stated-rather-than-hidden). An earlier version of this
sentence listed contractor data as loaded, which the rest of this file contradicted.

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

| Table                                                                        | Rows                           | Source                                                                                |
| ---------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------- |
| properties (one row per assessed parcel, 62 columns)                         | **215,806**                    | FL DOR NAL 2026P                                                                      |
| permits in the source layer (3,312 roofing · 3,753 open · 247 open roofing)  | **17,671**                     | Lake County CD Plus, windowed on `Permit_LastModDate`                                 |
| permits linked to an assessed parcel · valid unlinked                        | 17,457 · **214**               | 119 permit parcel keys are absent from the roll; the records are counted, not dropped |
| permits as counted in the published table (3,256 roofing · 226 open roofing) | **17,457**                     | the linked subset — the API and UI report against this denominator, not 17,671        |
| coordinates                                                                  | **209,503** (97.1%)            | FL GIO parcel centroids 2025                                                          |
| business accounts in the source roll (1,883 construction, 44 roofing)        | **33,346**                     | FL DOR TPP 2026P                                                                      |
| business accounts matched to a parcel and published                          | **2,060** (6.2%)               | street+zip match; the TPP roll carries no parcel key                                  |
| sale records                                                                 | **37,020** over 30,977 parcels | FL DOR SDF 2026P                                                                      |
| distinct owner names                                                         | **168,315**                    | FL DOR NAL                                                                            |

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
  DuckDB├─ join → 62-column query table → gate: rows == distinct folio, 0 null folios
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

The application's own suite runs from the repo root. 69 of the 317 tests exercise the
query layer against a real 215,806-row table rather than a fixture, so they skip unless one
is reachable; point them at the published run to run everything:

```bash
pnpm install && pnpm run build
ORACLE_PARQUET_URL="https://ipfs.filebase.io/ipfs/$(jq -r .rootCid artifacts/latest.json)/query-table.parquet" \
  pnpm run test:unit          # 317 passed
```

Full pipeline commands are in [`docs/runbook.md`](docs/runbook.md).

## Fetch the data with nothing but curl

```bash
ROOT=$(jq -r .rootCid artifacts/latest.json)
curl -sL "https://ipfs.filebase.io/ipfs/$ROOT/coverage.json" | jq .tables.properties.rows
curl -sL "https://gateway.pinata.cloud/ipfs/$ROOT/query-table.parquet" -o query-table.parquet
duckdb -c "SELECT count(*) FROM 'query-table.parquet' WHERE roof_age_years >= 15 AND open_roofing_permit_count > 0"
```

## No single gateway can take this down

Both read paths — the Lambda and the browser — try several gateways for the same
CID and use the first that answers. Pinning one vendor's gateway put the runtime
in tension with this project's own rule that a vendor-specific HTTP URL is never
the source of truth, and made the no-ongoing-cost claim depend on one account
staying live. The CID is the source of truth; a gateway is transport.

Measured against the published Parquet on 2026-09-10, following redirects
(`curl -sL -r 0-1023 -H 'Origin: ...'`), rather than assumed:

| Gateway                                                          | Range | CORS | Used                                     |
| ---------------------------------------------------------------- | ----- | ---- | ---------------------------------------- |
| `ipfs.filebase.io` · `gateway.pinata.cloud` · `gw.ipfs-lens.dev` | 206   | `*`  | in order                                 |
| `ipfs.io` · `dweb.link` · `w3s.link`                             | 206   | `*`  | last — they rate-limit datacenter egress |
| `4everland.io`                                                   | 301   | `*`  | recorded unusable, not silently omitted  |

The `-L` matters, and a first pass here got it wrong without it: `dweb.link` and
`w3s.link` answer 301 to a subdomain gateway and serve the range from there, so
every real client sees 206. An earlier note in this repo claimed Filebase was the
only gateway serving both CORS and Range; five others do.

The published run is verified across all of them. Every one of the ten checked
artifacts of run `20260910T153418Z` — including the 20 MB Parquet and a 14 MB
shard — returned bytes matching the manifest's length and SHA-256 from **all five
gateways in the registry**: `ipfs.filebase.io`, `gw.ipfs-lens.dev`,
`gateway.pinata.cloud`, `ipfs.io` and `dweb.link`. The run before it matched on
three, because `ipfs.io` and `dweb.link` rate-limited datacenter traffic at the
moment it was checked; a gateway that does not answer is recorded as
asked-and-not-matched rather than quietly dropped, so the count in `latest.json`
is whatever actually answered, evidenced in `artifacts/verification-<run>.json`.
The kit's verifier stops at two by design, which is why a publish records only
two; `scripts/reverify-across-gateways.mjs` sweeps the full list for the evidence
record without changing the pass criterion or touching the vendored kit.

## Import the whole DAG as a CAR, from anyone's gateway

The published `.car` files are reproducible build output and are not committed, but they do
not need to be: the CAR's root **is** the published root CID, so any gateway will export the
identical DAG on demand. Nothing here touches Filebase or this repository.

```bash
ROOT=$(jq -r .rootCid artifacts/latest.json)
[ "$ROOT" = "$(jq -r .carCid artifacts/latest.json)" ] && echo "car root == published root"
curl -sL -H 'Accept: application/vnd.ipld.car' \
  "https://ipfs.filebase.io/ipfs/$ROOT?format=car" -o lake.car     # 326,147,854 bytes
ipfs dag import lake.car
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

## Four runs, four CIDs, prior data untouched

| Run                | Mode        | Root CID            | Property deltas   | Gateways verified |
| ------------------ | ----------- | ------------------- | ----------------- | ----------------- |
| `20260909T182356Z` | full        | `bafybeigb3g…rltee` | 215,806 inserted  | 5                 |
| `20260909T185056Z` | incremental | `bafybeiay65…z33q`  | 215,806 unchanged | 2                 |
| `20260910T135850Z` | incremental | `bafybeif5vp…ok67q` | 215,806 unchanged | 2                 |
| `20260910T153418Z` | incremental | `bafybeibshs…4fr4m` | 215,806 unchanged | 5                 |

The IPNS name resolves to the newest run; every run's own root CID is permanent. Run one's
root still resolves after every later republish, and the run before all of them, published
earlier on the 9th, was independently re-checked from three gateways and returns a
byte-identical manifest — that evidence is in `artifacts/prior-publication.json`.

The later runs' deltas are genuinely zero, and that is reported rather than dressed up. The
second run re-fetched the 304 permits whose `Permit_LastModDate` had moved in the preceding
four days and merged them by permit number, which collapsed 244 duplicate feature rows but
changed no property-level value. The third added three business columns to the query table.
The fourth changed no data at all: it republished the same table with a corrected artifact
manifest — directory digests over the dag-pb nodes rather than over the CID string, no
always-empty `origins`, no build-machine path in the published root — and a coverage
snapshot that now states the business-coverage limitation in machine-readable form. A
property delta appears when a permit changes status, a roof gets a new completion date, or
the DOR publishes a new roll. The mechanism is exercised and the result is honest: nothing
this pipeline measures had changed between them.

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
- **Contractor identity and BBB ratings are not published — for two different reasons.**
  Contractor of record lives on county permit detail pages behind a Cloudflare managed
  challenge covering the whole `lakecountyfl.gov` estate, and that one is a hard technical
  block: re-verified on 2026-09-10 with plain `curl` **and** with a real headless browser,
  both 403. BBB is a _policy_ boundary, not a technical one. `bbb.org` answers 403 to
  `curl`, but a profile page does load in a browser — and harvesting it that way is
  precisely what the kit's `bbb-harvest` skill forbids: BBB's `robots.txt` disallows
  crawling its query-string URLs, and the skill requires that a 403 be treated as a stop
  with access requested through the official BBB API, explicitly ruling out changing egress,
  proxies or browser fingerprints to get around it. An earlier version of this file said
  only "`bbb.org` answers 403", which understates the reason and overstates the block.
  Both are real columns that stay null, with the reason in `enrichment_status`. Nothing is
  invented.
- **Ten-year ownership tenure cannot be proven.** Only the current DOR roll is published and
  it carries 2025-2026 sales; the historical DOR map-data files back to 2005 carry parcel
  geometry only, which was verified by downloading the 2010 file and reading its two-field
  attribute table. `no_recorded_sale_in_dor_window` is a lower bound, not a tenure claim.
- **Coordinates come from the 2025 centroid release against the 2026 roll**, so 6,303
  parcels (2.92%) publish with null coordinates rather than being dropped. A separate
  figure, the 2.26% in the readiness exception, measures something else: the gap between
  the 210,935-row GIS release and the 215,806-row assessed roll. The two are easy to
  conflate and an earlier draft of this file did exactly that.
- **214 of the 17,671 permits attach to no published property.** They name 119 parcel keys
  absent from the assessed roll. They are valid records and are counted rather than
  discarded, which is why the permit total and the linked total differ above.
- **Business coverage is 6.2% of the TPP roll, and the published per-parcel total double
  counts.** 32,738 of the 33,346 accounts carry a situs address and 2,060 match a parcel;
  summing `business_account_count` across the 2,726 parcels that carry one yields 4,451,
  because 90 address groups span more than one parcel. Detailed below.

### Found after this run was published

Two city values in the DOR roll are source typos: `LAKDY LAKE` and `tavares`, one parcel
each out of 215,806. They are published exactly as the roll writes them rather than being
silently corrected, because the published table is meant to be the roll, not an improved
version of it. Filters are case-insensitive (`upper(address_city) = ...`), so a search for
Tavares still returns the lowercase row; `LAKDY LAKE` will not match a search for Lady Lake,
and that is the one parcel it costs. Both show as their own entries in the city facet list.

Unlike the limitations above, this one is **not** in the published `coverage.json`. It was
found while auditing the runtime, after the run's CID was fixed, and recording it here was
preferred to quietly leaving it out.

**Business coverage is 6.2% of the source roll, and the published total double counts.**
The TPP roll carries no parcel key, so accounts are located by a normalized street+zip
match against the roll's situs addresses. 32,738 of the 33,346 accounts carry a situs
address and 2,060 of them match a parcel, so the other 94% are not published. Separately,
a matched address group is attributed to _every_ parcel sharing that address, so summing
`business_account_count` across parcels yields 4,451 rather than 2,060 — 90 address groups
covering 180 accounts span 1,214 parcels. The UI labels that figure "TPP account–parcel
matches" rather than a count of businesses, and the Business view says so in full.

This one **was** prose-only for three runs, and that was the defect: the README said it
plainly while `coverage.json` — the machine-readable record every API, MCP tool and agent
reads — did not, so any consumer that was not a human reading this file had no way to learn
it. Since run `20260910T153418Z` it is the eighth entry in the published `limitations[]`,
and the snapshot carries a `tables.businessAccounts` block with the matched, attributed and
shared-address counts. The figures are computed from the roll on every run rather than typed
in, so a later roll cannot leave a stale number behind.

`NAICS_CD` and the account name are now carried. Run `20260910T135850Z` republished the
query table under a new root CID with three added columns — `business_naics_codes`,
`business_names` and `roofing_business_count` — so the roll's 44 roofing contractors are
queryable where their situs address matches a parcel, which is 10 of them. That is the only
contractor-shaped signal obtainable from a published source, and it names businesses at an
address rather than asserting who worked on a roof.

The shared-address double count is unchanged and still stated above: it is a property of the
street+zip join, not of the columns, and de-duplicating it would change what
`business_account_count` means rather than correct it.

## Gaps that were open, and how each one closed

This section listed what was written but unproven. Nothing on it is open any more. It is
kept rather than deleted, because a document that erases the record of its own gaps as they
close stops being worth reading. Each entry names the evidence that closed it.

- **The chat agent calls a model, on the deployed runtime.** The key lives in Secrets
  Manager and the function fetches it at cold start. Asked on 2026-09-10 how complete the
  business coverage is and where that is stated, the deployed `/api/chat` answered from the
  coverage snapshot's own `businessAccounts` block — 2,060 of 33,346 accounts, 4,451
  attributed across 2,726 parcels — citing `searchDocuments` and `getDatasetInfo` against run
  `20260910T153418Z`. The Vercel AI SDK path with its five Zod-schema tools and its citation
  collector is therefore exercised, not merely written. In the test suite only the "no key
  returns 503" branch is covered, because the suite never reaches a model provider on purpose.

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

Both the pull request and the demo video now exist. The work is proposed as
[PR #2](https://github.com/prismteam-ai/oracle-property-intelligence-platform-pipeline-lake-fl/pull/2)
against the assignment repository — a **draft**, deliberately, until the owner marks it ready
— and a 7 min 16 s screen recording of the deployed runtime, following the assignment's
presenter script, is attached at the bottom of its description. An earlier version of this
line said neither had been authorised, which was true when it was written and is not now.

## Team-kit usage

`arceus` routed the work; `oracle` drove `onboard-county`, `county-discovery`,
`county-readiness-preflight`, `county-seed-data`, `county-permit-adapter`,
`county-ingest-run`, `county-open-data-publish` and `county-query-table-publish`;
`metagross` with `build-frontend-backends` built the application; `apply-engineering-guidelines`
applies throughout. The readiness validator is a hard gate and passes on all five gates.
Deviations, including the stack question that had to be put back to the operator because the
bundled runtime contains no Restate stack, are documented rather than glossed.
