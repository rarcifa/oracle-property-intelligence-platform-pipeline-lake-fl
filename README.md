# Oracle Property Intelligence Platform Pipeline - Lake County, FL

## Assignment evidence — 2026-09-17

This repository supplies the Lake County property-intelligence pipeline, not the
Roofing CRM or owner outreach. The [original assignment brief](#original-assignment-brief)
is preserved verbatim below. The evidence matrix follows every requirement in it.

The full **58,495-record Clermont 2015–2026 harvest is retained**; no year in that
range is missing and it has not been restarted. Together with Lake CD Plus, the
finalized baseline contains **215,806 properties, 76,166 permits, 33,346 business
accounts and 209,503 property coordinate pairs**. Historical permit types,
statuses, dates and source-listed contractor names are available where captured.
They do not establish which roofing permits are currently open or their duration.

The baseline publication is now genuinely **`FINALIZED`**, with independent
Lighthouse retention of its complete CAR, every-object two-public-gateway proof,
successful history, latest pointer and verified IPNS sequence 14. A real later
refresh adds **265 permits and updates 801**, producing **76,431 permits** and
distinct root/manifest/CAR CIDs. Its primary Filebase imports are accepted, but
Lighthouse archive retention and complete gateway verification remain pending.
It is **not** a second finalized publication or a promoted latest/history/IPNS run.

The baseline documentation RAG selector is now **published** and bound to that
finalized root. The [actual hosted readback](artifacts/hosted-runtime-readback-20260917.json)
records the deployed app-source identity, selected run, counts, finalized
publication and ten MCP tools; [delivery handoff](docs/submission-handoff-20260917.md)
separates that identity from the PR head. The latest hosted take independently
replayed all 25 displayed canonical agent rows, a normal safe-refusal follow-up
and 50 historical permit rows. It failed the strict paint check on one actual
40 ms black frame. Replacement-take outcome, exact-head CI and fresh Slowking
review are separately recorded in the delivery handoff. Earlier recordings remain dated evidence, not
proof of later changes. County completeness and a passed full-assignment demo
are not claimed.

### Where to evaluate

- [Existing designated PR #2](https://github.com/prismteam-ai/oracle-property-intelligence-platform-pipeline-lake-fl/pull/2).
  Local edits are not proof that its remote head already contains them.
- [Hosted UI, REST, MCP and agent](https://tf2ynypdvfkv4dqxszpkj5emjq0imyxh.lambda-url.us-east-2.on.aws/).
  The [current readback](artifacts/hosted-runtime-readback-20260917.json)
  establishes the repaired deployment. The [16:02 UTC receipt](artifacts/hosted-runtime-readback-20260917-before-score-repair.json)
  is preserved separately as historical evidence.
- [Baseline manifest](artifacts/manifest-20260916T181000Z.json),
  [normal verification](artifacts/verification-20260916T181000Z.json),
  [publication ledger](artifacts/publication-attempts.json),
  [successful history](artifacts/run-history.json) and [latest](artifacts/latest.json).
- [Delivery handoff](docs/submission-handoff-20260917.md): exact CIDs, CAR
  retrieval/import instructions, achieved outcomes and remaining evidence.
- [Earlier partial walkthrough](docs/demo-preview-final-20260917/walkthrough.webm)
  and [its immutable report](docs/demo-preview-final-20260917/preview-demo.json).
  Despite the historical directory name, this is not the pending replacement take.
- [Latest hosted take, failed paint check](docs/demo-score-repair-failed-paint-20260917/walkthrough.webm)
  and [its immutable report](docs/demo-score-repair-failed-paint-20260917/failed-preview-demo.json).
  Its canonical-row and historical-table replay succeeded; the recording did not.

### Evidence boundaries

**Recorded publication** means exact byte identities and durable publication
receipts exist for the named run. **Verified locally** does not establish hosted
or public behavior. **Source-constrained** describes available coverage and a
documented access limitation, not an automatic pass or failure. **Unmet** means
the expected result is unsupported; a test, plan or limitation note cannot make it pass.

| Boundary                                 | Properties | Permits | Actual meaning                                                                                                                                                    |
| ---------------------------------------- | ---------: | ------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Historical public run `20260910T225242Z` |    215,806 |  17,671 | Superseded successful release, not current latest or the full Clermont harvest.                                                                                   |
| Historical local run `20260911T131000Z`  |    215,806 |  21,732 | Unpublished, root=null. Original bytes are retained only as historical regression fixtures; no CID or current source-only semantics are borrowed.                 |
| Earlier private query repair             |    215,806 |  76,166 | [Real-data query repair](docs/lake-query-repair.md); its earlier decisions are not approval of conservative permit conclusions.                                   |
| Finalized baseline `20260916T181000Z`    |    215,806 |  76,166 | 72,187 linked and 3,979 valid unlinked permits; source-only coverage, not county-complete. Latest/history/IPNS and published documentation RAG now bind this run. |
| Pending incremental `20260917T152549Z`   |    215,806 |  76,431 | 72,450 linked and 3,981 valid unlinked permits; accepted primary imports, queued archive retention, no finalized history/latest/IPNS promotion.                   |

### Loaded source coverage and reconciliation

| Source / grain               | Retained coverage                                                                  | Limitations and interpretation                                                                                                                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FL DOR NAL assessed roll     | 215,806 distinct parcels; available owner names/mailing fields                     | Current roll, not historical ownership chains or verified contact/residency. All assessed parcels remain even when coordinates or joins are missing.                                                                 |
| FL DOR SDF sales             | 37,020 source records, 2025–2026 window                                            | No recorded sale in this window does not prove ownership unchanged for ten years.                                                                                                                                    |
| FL DOR TPP business accounts | 33,346 accounts; 2,060 matched, 31,286 valid unmatched                             | 4,451 account–parcel attributions involve 2,726 properties. These are different grains, not 4,451 businesses or verified legal-company identities.                                                                   |
| FL GIO parcel centroids      | 210,935 source features; 209,503 joined property coordinate pairs                  | 6,303 properties have null joined coordinates. Source parcel centroids are not surveyed roof/GPS positions.                                                                                                          |
| Lake CD Plus permits         | Baseline 17,671 distinct permits; incremental 17,936                               | Unincorporated Lake and constrained source history, not complete all-jurisdiction permit history. Contractor names are absent from this layer.                                                                       |
| Clermont eTRAKiT permits     | 58,495 permits across all twelve 2015–2026 partitions                              | Raw historical type/status/date/name fields preserved where captured. Source-listed names do not verify licenses or legal entities.                                                                                  |
| Other permit jurisdictions   | All 15 authorities enumerated in [source catalog](pipeline/docs/lake-sources.yaml) | Thirteen other municipal routes have recorded blocked, unavailable or manual-only limitations; unacquired history is unknown, not zero.                                                                              |
| BBB / ratings                | No approved ratings ingested                                                       | Default route returned 403. A historical prohibited desktop-user-agent request returned 200 and yielded no ingestion; access is policy/API-gated, not universally unreachable. Null is unavailable, not a bad score. |
| Sunbiz / DBPR identity       | No adequate loaded temporal identity baseline established                          | Separate kit-conformance gap; DOR TPP and contractor name strings are not corporate/licensing evidence.                                                                                                              |

The [catalog](pipeline/docs/lake-sources.yaml) records source routes, jurisdictions,
periods and access constraints. Original private captures remain private; public
derivatives have source/run/digest provenance. Export time is not substituted for
an unknown capture time. Stable folio and permit identities reconcile supported
joins; ambiguous and valid unmatched records are preserved rather than discarded.

There are **169,007 valid actual-built-year proxies**, of which **120,362 are
at least 15 years old as of 2026-09-16**. This is a low-confidence building-age
proxy allowed by the brief, not measured roof age. Partial permit history may
omit replacements; no accepted permit-backed primary-roof reset is inferred.
Strictly **older than 15** uses integer minimum age **16**, not 15.

[Retained Clermont evidence](artifacts/clermont-historical-permit-evidence-20260917.json)
contains **9,969 literal `ROOF/REROOF` observations**, including **276 with source
status `ISSUED`**, 266 with an issued date, and 135 issued before 2021-09-17.
These records are present and queryable. They are not 276 confirmed currently-open
permits; raw issued dates are not accepted days-open calculations. A bounded
normal-route detail probe timed out; no challenge evasion or semantic promotion followed.

The [published baseline partition evidence](https://ipfs.filebase.io/ipfs/bafybeigakr7d6nywkbanzmh4r7cpv7kz7qs5vxvwlxcxuovk2lobrj442u/clermont-baseline-evidence.json)
records each year as `captured_complete`, with zero retryable-pending and
proven-dead records. These are retained acquisition counts, not accepted
current-open permit counts or a new certification round.

| Year | Retained permits | Year | Retained permits |
| ---- | ---------------: | ---- | ---------------: |
| 2015 |            3,436 | 2021 |            5,642 |
| 2016 |            3,958 | 2022 |            5,778 |
| 2017 |            4,234 | 2023 |            5,801 |
| 2018 |            4,492 | 2024 |            5,893 |
| 2019 |            4,420 | 2025 |            5,806 |
| 2020 |            4,880 | 2026 |            4,155 |

Total: **58,495**, matching the merged retained export.

### Publication and actual incremental progress

| Identity                            | Finalized baseline                                            | Pending incremental                                           |
| ----------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------- |
| Run                                 | `20260916T181000Z`                                            | `20260917T152549Z`                                            |
| Root CID                            | `bafybeigakr7d6nywkbanzmh4r7cpv7kz7qs5vxvwlxcxuovk2lobrj442u` | `bafybeicuvlx746twkowvsaz5g73ijajjirvxberemew747krlknfk5do7q` |
| Manifest CID                        | `bafkreiezsu6lbe7v43vv5hq26tp2ucojuajvpntapw2rn6fhntuq3oyopm` | `bafkreih5po2tge25ze6c5snnecdkumcoovkrrke7csh7haa63hjxtlyl4e` |
| Complete snapshot CAR CID           | `bafybeicasgbg4y75477jq73lm7rsiw4a6gcbz4yjxdy6dicv5aj2q5oriq` | `bafybeie2isprhs53basx5g7ti3dufip5buw4qnihysshswhgsij4yyalpa` |
| Eligible objects / plus manifest    | 40 / 41 verified                                              | 41 / 42 observed; only 16 currently two-host verified         |
| Logical CAR bytes / verified blocks | 341,012,658 / 1,352                                           | 341,074,069 / 1,353                                           |
| Durable state                       | `FINALIZED`, 2026-09-17 17:33:43 UTC                          | `MANIFEST_UPLOAD_RECORDED`; archive retention queued          |
| Latest / successful history / IPNS  | Recorded; IPNS sequence 14 resolves baseline root             | Not advanced for this run                                     |

The baseline [normal publisher verification](artifacts/verification-20260916T181000Z.json)
contains **41/41** two-host size/digest matches from public Filebase and Pinata
gateways. Its ledger records completed Lighthouse retention of the manifest and
full multi-root CAR, with all 1,352 blocks verified and directory roots covered.
A local-only finalization repair completed the already-consumed normal attempt;
it did not upload, repin or repoint IPNS, and preserved execution commit
`4fc47a475bd01d483b81150b741914eec2f8bc32`. Successful history/latest now agree.
This is independent retained availability at the recorded check, not a promise
of free-forever persistence or survival after every retained copy disappears.

[Incremental integration](artifacts/incremental-integration-20260917T152549Z.json)
compares actual Parquet records: **265 inserted, 801 updated and 16,870 unchanged**
CD Plus records. All 58,495 Clermont records and all business bytes are unchanged.
The bounded source window was captured at `2026-09-16T18:05:22.523Z`; unchanged
older rows do not acquire new observation timestamps. No removals in the retained
projection do not prove no deletions outside that source window. The integration
receipt's earlier `held_local_candidate` state describes its 15:28 capture,
not the later accepted primary imports.

The [18:06 public observation](artifacts/incremental-public-gateway-observation-20260917.json)
checks all **42** objects including the manifest, but verifies only **16** on two
hosts; the complete CAR and manifest are among the successes. Pinata 429 responses
and failed fallback fetches leave 26 incomplete. It is not normal `VERIFIED`
or independent-retention evidence. The [18:09 Lighthouse dashboard observation](artifacts/lighthouse-incremental-queue-observation-20260917.json)
shows the exact archive migration request **queued**, not failed. Its notice says
migration may require approximately 24 hours; this is a provider notice, not our
completion-time guarantee or an established billing issue. No duplicate pin,
new account or upgrade was performed.

The [baseline RAG promotion receipt](packages/rag/promotion-receipt.json) and
[validated selector](packages/rag/corpus-source.json) now bind published baseline
artifacts. Documentation retrieval remains distinct from canonical property-row
evidence. [Index build metadata](packages/rag/index-data/lake-rag-index.json) records the actual
source snapshot and counts; it must be rebuilt when indexed inputs change.
The deployed consumer and live readback bind this finalized baseline; recording
and row replay must independently verify the same run/root.

## Every acceptance criterion: evidence and remaining boundary

These IDs are navigation labels, not invented rubric weights. Constraints explicitly
requested in the brief are reported without making conditional enrichment mandatory
or describing unknown data as a successful zero-result query.

### Geography and data loading

| ID  | Brief requirement                                            | Evidence / achieved result                                                                            | Remaining boundary                                                                                                         |
| --- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| G1  | Default/primary Lake County, FL                              | Lake / FIPS 12069 in dataset coverage and earlier hosted readback                                     | Replacement deployment must retain this identity.                                                                          |
| L1  | Run until all available county data is uploaded              | Full assessed roll and all retained Clermont 2015–2026 loaded; baseline finalized                     | Source/jurisdiction history remains partial; no all-county-complete claim.                                                 |
| L2  | Available property records                                   | 215,806 public baseline properties                                                                    | Missing enrichment never removes a parcel.                                                                                 |
| L3  | Available permits, emphasizing roofing                       | 76,166 finalized baseline permits; 76,431 pending incremental; retained literal roofing observations  | Current roofing/lifecycle conclusions remain unsupported.                                                                  |
| L4  | Status/open/close dates or equivalent; duration-open signals | Historical status/date fields retained where present                                                  | Current-open and defensible duration-open result unmet; equivalent source fields need not be three invented closing dates. |
| L5  | Available ownership                                          | NAL owner names/mailing fields and available sales observations                                       | Not complete ownership history or verified residency/contact.                                                              |
| L6  | Available contractors                                        | Source-listed Clermont contractor names in historical permit rows                                     | Not legal-company/license verification; other jurisdictions remain unknown.                                                |
| L7  | Public BBB/ratings where available                           | No approved data; policy/API constraint documented                                                    | Unavailable/null explicitly shown; no invented score or indefinite wait for conditional enrichment.                        |
| L8  | Available businesses                                         | All 33,346 TPP accounts, including 31,286 unmatched                                                   | Account–parcel candidates do not prove legal identity or contracting work.                                                 |
| L9  | Coordinates for radius queries                               | 209,503 valid joined pairs; actual radius queries                                                     | 6,303 properties lack joined coordinates and remain retained.                                                              |
| L10 | Roof age or allowed proxies, configurable threshold          | Valid built-year proxies, LOW confidence; strictly>15 uses 16                                         | As-of 2026-09-16; not measured roof age or complete replacement history.                                                   |
| L11 | Duplicate reconciliation                                     | Stable folio/permit identities, linked/unlinked conservation and actual incremental record comparison | Cross-source legal-entity identity unresolved; shared address/name alone is not equality.                                  |
| L12 | Provenance                                                   | Source/run/root/SQL and immutable input/export digests                                                | Unknown capture timestamps remain unknown.                                                                                 |

### Continuous and incremental ingestion

| ID  | Brief requirement                                            | Evidence / achieved result                                                                           | Remaining boundary                                                                                                             |
| --- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| I1  | Ongoing new/changed ingestion, bounded windows, idempotence  | Real bounded refresh, 265 inserts/801 updates, idempotent replay                                     | Later publication not finalized; no deletion coverage outside window.                                                          |
| I2  | Visible run history, timestamps/sources/counts/deltas/limits | [Successful history](artifacts/run-history.json) now includes full baseline; coverage carries limits | Later run cannot enter successful history before finalization. Property row-hash deltas are distinct from table count changes. |
| I3  | Multiple ingests and immutable republishes over time         | Actual changed records produce distinct new CIDs; old bytes unchanged                                | Second complete retained/public publish and both successful history entries not yet demonstrated.                              |

### Infrastructure and access

| ID  | Brief requirement                             | Evidence / achieved result                                                                                                   | Remaining boundary                                                                                                    |
| --- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| A1  | Optimize where feasible                       | Bulk roll/API ingestion, bounded recovery, direct Parquet joins, [performance model](docs/cost.md)                           | Historical benchmarks are not present harvest ETA promises.                                                           |
| A2  | Identify slow/constrained sources             | Slow Clermont HTML, managed challenges/manual routes, policy gates, paging/IN-list caps, queued retention and gateway limits | Constraints are source-specific, not excuses to discard retained data or evade controls.                              |
| A3  | Document limitations                          | [Catalog](pipeline/docs/lake-sources.yaml), coverage, cost/runbook and this evidence map                                     | Final runtime/demo must show matching source/period limits.                                                           |
| A4  | No default ongoing Oracle infrastructure cost | Portable files and consumer-side DuckDB; optional owner-funded hosting                                                       | Retention, model calls and optional hosting have costs; no required always-on Oracle database.                        |
| A5  | IPFS eligible artifacts                       | Finalized public baseline, independently retained full CAR                                                                   | Later eligible snapshot still awaits retention/all-object verification. Private raw/contact payloads excluded.        |
| A6  | Local/portable DuckDB                         | Real-data DuckDB querying and portable Parquet access                                                                        | Lambda is an optional convenience, not a required persistent database.                                                |
| A7  | MCP-ready model                               | Ten hosted MCP tools over property/permit/business data with actual selected-run readback                                    | Unsupported conclusions remain guarded.                                                                               |
| A8  | Agent database access                         | AI SDK/Zod tools; hosted canonical aged-roof/radius answer with all 25 displayed rows independently replayed                 | Recording outcome separately identified in the handoff; no model prose accepted as property evidence.                 |
| A9  | Data-exploration UI                           | Real hosted views; search error UX and partial metadata repaired; strict sampled paint checks retained                       | Actual 40 ms failed paint sample preserved; underlying cause unproven and no claim that all blackouts are eliminated. |

### IPFS publication

| ID  | Brief requirement                                                          | Evidence / achieved result                                                                                                                       | Remaining boundary                                                                                                       |
| --- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| P1  | CID durable identity, URL convenience only                                 | Exact immutable root/object/manifest/CAR CIDs                                                                                                    | HTTP provider locator is never the source of truth.                                                                      |
| P2  | Prefer CIDv1 base32                                                        | Baseline and candidate identities use CIDv1/base32                                                                                               | Preserve identities on transport/import.                                                                                 |
| P3  | Survive local/demo and any single pin vendor loss                          | Baseline Filebase import plus verified Lighthouse complete CAR/root retention                                                                    | Point-in-time retention evidence, not guaranteed eternal availability; incremental archive still queued.                 |
| P4  | Per-run manifest with every eligible CID/path/size/codec/digest            | Baseline 40-object JSON plus manifest verification; new frozen 41-object manifest                                                                | New manifest's public bytes are verified but complete normal run verification is pending; optional origins not invented. |
| P5  | IPNS name and resolved run CID                                             | Name recorded with baseline resolved root; sequence 14 verified                                                                                  | New IPNS sequence/resolution not claimed before publication.                                                             |
| P6  | New data/new CID, old immutable CIDs/history                               | Genuine 265/801 changes produce distinct new root/manifest/CAR; baseline unchanged                                                               | Later successful publish/history and fresh prior/new retrieval demonstration pending.                                    |
| P7  | Complete directory DAG CAR                                                 | Baseline multi-root CAR public, 1,352 valid blocks; new CAR 1,353 blocks and current two-host full-byte proof                                    | Logical CAR differs from upload transport/export; new retention not completed.                                           |
| P8  | Every listed CID fetched from two independent public gateways; bytes match | Normal baseline 41/41 size/digest proof                                                                                                          | New standalone 16/42, not 42/42. Gateways are public unauthenticated hosts not candidate-operated.                       |
| P9  | Manifest/CAR in repo or demo packet for later retrieval                    | Committed baseline manifest and public CAR with [import instructions](docs/submission-handoff-20260917.md); new manifest/CAR identities included | New snapshot is not represented as a finalized release.                                                                  |

The brief's ipfs.io/dweb.link examples are not exclusive gateways. Public Filebase
and Pinata hosts provided the baseline proof; neither is operated by this candidate.
Two gateway responses alone are not proof of independent pinning: baseline
Lighthouse CAR/root retention is separate evidence. Historical 429, CORS and Range
constraints remain documented rather than bypassed.

### Roofing CRM–supporting queries

| ID  | Brief requirement                                  | Evidence / achieved result                                                                                                              | Remaining boundary                                                                                                                                     |
| --- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q1  | Radius around GPS/map point                        | Actual coordinate-backed five-mile queries with SQL/run provenance                                                                      | UI map/GPS interaction design is out of pipeline scope.                                                                                                |
| Q2  | Roofs over 15/configurable threshold               | At fixed pin 28.5494,-81.7729, integer threshold 16 returns 23,696 building-age proxies                                                 | Natural-language Clermont uses a labelled selected-data parcel-centroid centre; results depend on centre. LOW-confidence proxy, not measured roof age. |
| Q3  | Open roofing, especially long-open                 | Raw historical ROOF/REROOF, ISSUED/date observations retained                                                                           | Current-open and duration unknown; initial and follow-up requests safely refused, not fulfilled by an empty list.                                      |
| Q4  | Permit details, contractor and BBB where available | Historical permit details and source-listed Clermont names                                                                              | BBB/license/legal identity unknown; no inferred verified contractor.                                                                                   |
| Q5  | Ownership unchanged for over ten years             | Available owner/sales evidence preserved                                                                                                | Unmet: 2025–2026 sales cannot establish ten-year tenure.                                                                                               |
| Q6  | Regional/out-of-area owners                        | NAL owner-mailing geography query and Tenant view                                                                                       | Labelled locality proxy, not verified residency.                                                                                                       |
| Q7  | Source-backed answers                              | Canonical property answers from actual this-turn query rows; latest hosted take independently replayed all 25 displayed rows and fields | Recording failed paint, not row grounding. Historical wrong-prose/citation and abstention failures remain preserved.                                   |

### Demonstration

| ID  | Brief requirement                         | Evidence / achieved result                                                                  | Remaining boundary                                                                            |
| --- | ----------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| D1  | Uploaded dataset in UI                    | Hosted take exercised real selected records and independently checked 50 historical rows    | Recording outcome in handoff; not full-county completion.                                     |
| D2  | Roofing-aligned agent query               | Hosted original aged-roof/radius question returned 25 independently replayed canonical rows | Recording outcome in handoff; unsupported open request safely refused with HTTP 200.          |
| D3  | No Oracle infrastructure cost             | Portable DuckDB/MCP/CID design and [cost account](docs/cost.md)                             | Demonstrate portable read path; identify ongoing owner/vendor-funded costs.                   |
| D4  | Public CID manifest/two-gateway retrieval | Baseline complete proof plus independent Lighthouse retention                               | Recording links in handoff; later complete incremental publication still pending.             |
| D5  | Both Oracle and builder responsibilities  | Real collection/loading/reconciliation, publication and query/UI implementation evidenced   | These achieved parts do not certify full milestone fulfillment.                               |
| D6  | Pass demo with real Lake records          | Real selected records demonstrated; `fullAssignmentDemoPassed:false`                        | Recording outcome in handoff; current-open, tenure and county coverage remain genuine limits. |

## Demo transcript: every expected-result beat

This checklist tracks the original transcript, not a declaration that all beats pass.
[Demo script](docs/demo-script.md) and [preview recorder](packages/ui/scripts/record-preview.mjs)
bind actual run/root, manifest bytes, browser stability and independent canonical-row
replay. Source-only refusal keeps the full-assignment pass false.

| Step | Brief expected result                                                     | Evidence / exact missing outcome                                                                             |
| ---- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| M0   | Loaded Lake dataset, DuckDB, immutable IPFS and roofing UI/agent          | State partial county coverage and exact finalized baseline run/CID; no full-county claim.                    |
| M1   | Completed run summary, sources/counts/timestamps/limits                   | Baseline successful history/publication and actual hosted summary recorded; county limits explicit.          |
| M2   | Totals by property/permit/owner/contractor/BBB/business/coordinate source | Counts/grains above; unavailable BBB and unknown capture times explicit.                                     |
| M3   | DuckDB without Oracle-hosted database                                     | Portable files/query path; optional owner-funded Lambda is not a hosted database requirement.                |
| M4   | Manifest fields and IPNS name/resolved CID                                | Baseline manifest and verified sequence 14; exact recording evidence in handoff.                             |
| M5   | Two public fetches with size/digest matches                               | Baseline normal 41/41 proof and public complete CAR; record actual selected artifact checks.                 |
| M6   | Later incremental CID, prior immutable CID, both histories and CAR        | Actual new bytes/primary CIDs/CAR exist; retention/all-object proof/finalized history/IPNS still pending.    |
| M7   | UI radius/roof over 15 with basis/coordinates/provenance                  | Supported building-age proxy; strictly>15 means minimum16; exact recording evidence in handoff.              |
| M8   | UI long-open roofing, duration, contractor and BBB                        | Historical observations available; current-open/duration unmet, BBB unavailable.                             |
| M9   | Agent original aged-roof five-mile question                               | Hosted exact prompt returned 25 rows; every displayed canonical field independently replayed in latest take. |
| M10  | Agent long-open question and listed contractor                            | Pre-generation source-only refusal; not a current-open lead list.                                            |
| M11  | MCP-ready interface without changing model                                | Typed ten-tool hosted interface and actual selected run/root readback.                                       |

## Run and verify locally

Use Node **22.18+ below 23** and pnpm 10 as pinned in [package.json](package.json).

```bash
pnpm install
pnpm run build
pnpm run start
```

Configure the actual intended published dataset using
[server configuration](packages/server/README.md), [deploy guide](docs/deploy.md)
and [runbook](docs/runbook.md). Public-model chat requires an operator-provided key;
never commit it. Source-only current-open/completion decisions remain unavailable.

```bash
pnpm run build
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm run test
npm test --prefix pipeline
pnpm --dir pipeline exec tsc -p tsconfig.publication.json --noEmit
pnpm --dir infra run synth
```

The unit recipe materializes the original unpublished
`20260911T131000Z` historical test bytes using
[its manifest](packages/server/tests/fixtures/historical-20260911T131000Z/manifest.json)
and [local materializer](packages/server/tests/materialize-historical-fixture.ts).
It has root=null, is not a release, and never borrows current published data/CIDs.
Actual selected-source and documentation compatibility tests remain separate.

[Delivery verification](docs/submission-handoff-20260917.md#verification-boundary-and-final-fields-to-fill)
records exact local test totals, CI head/run/conclusion and the separate selected
public snapshot and historical regression-fixture boundaries. Local checks are
not current-head CI, deployment or assignment-demo proof. Actual CI results are
linked only after they finish; synthetic clean-runner fixtures never establish
production capture or deployment-byte validity.

## Official kit conformance and submission boundary

The global official `soofi-xyz-team-kit@soofi-xyz-team-kit` Codex plugin supplies
agents/skills; they are not copied into this repository. The current installed
kit is 0.52.0; earlier approvals used historical versions. `pipeline/` is retained
Lake-specific runtime code, not a second skill installation.

Arceus routed this finite repair through Oracle, `use-oracle` and
`apply-engineering-guidelines`, retaining the direct DuckDB/Node 22 consumer
stack. Prior authorship and retained-thread reuse are disclosed; reused reviewers
are not pristine fresh independent consultations. See [AGENTS.md](AGENTS.md),
[kit differences](pipeline/docs/lake-kit-deviations.md) and
[observability handoff](docs/observability-handoff.md).

The current kit's Sunbiz then adequate dated DBPR-before-permits order is not
established for the historical permit-first work. TPP/name strings are not an
identity baseline. That is a kit-conformance limitation, not an invented extra
brief requirement for available source-listed names. Full kit compliance is not
claimed. Arceus routing or owner consent is not evidence of the VP waivers
required for legacy executed JavaScript/PagerDuty deviations; external
Lexicon/Main Dashboard registration remains unproved.

No new provider, paid tier, harvest, personal-signature round or semantic waiver
is introduced by this documentation work. Existing Lighthouse Lite US$12/month
is the separately approved storage-ceiling exception; optional hosting/model
costs and retention funding remain explicit. Normal publication uses exact-target
recorded human consent, not removed personal signing. Commits must be only
`rarcifa <ricardo.arcifa@cronoslabs.org>`, with no co-authorship/AI trailers.

The [quality audit](docs/quality-audit.md) and earlier review/failed recording
receipts remain historical. A new Slowking score must identify the actual pushed
head and reachable deployment/video; no present score or current-head CI pass is
asserted. Final PR body, README, runtime identity and recording must agree.
Documentation alone does not promote selectors, deploy an app or finalize publication.

### Scope and references

The downstream [Roofing CRM](https://github.com/prismteam-ai/roofing-crm) consumes
this pipeline. CRM workflow, map-pin/GPS design, lead outreach and live outbound
owner messaging are out of scope; the required data-exploration UI remains in scope.

- [Roofing CRM & Lead Identification UI](https://github.com/prismteam-ai/roofing-crm):
  downstream query needs and scope.
- [Soofi XYZ Team Kit](https://github.com/soofi-xyz/soofi-xyz-team-kit):
  official agents, operating/engineering rules and evaluator.
- [Elephant Oracle Skills](https://github.com/elephant-xyz/skills):
  Lexicon/elephant-cli/Filebase+IPNS publication conventions.

This evidence layer does not modify the assignment's source text.

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
