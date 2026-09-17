# Oracle Property Intelligence Platform Pipeline - Lake County, FL

## Assignment evidence — 2026-09-17

This is the Lake County ingestion pipeline, not the Roofing CRM or an outreach
application. The [original assignment brief](#original-assignment-brief) below is
preserved in full. The implementation and evidence map follows that brief:
available data, reconciliation, incremental operation, portable DuckDB access,
roofing queries, public immutable IPFS artifacts, and a real-data demonstration.

The hosted partial preview serves **215,806 properties, 76,166 permits and
33,346 business accounts**, including the full retained Clermont 2015–2026
harvest. It has **not** been started over. An actual later CD Plus window is
integrated into a separate **76,431-permit** candidate. Every object in the
chosen public manifest has recorded size/digest matches from two public gateway
hosts, including its CAR. Independent secondary-provider retention and later
incremental publication remain unproven; neither county completeness nor a
passed full assignment demo is claimed.

This page separates code, public bytes, hosted preview and successful publication.
The hosted preview is explicitly pinned to `20260916T181000Z`; it does not move
IPNS, successful publication history, latest/row hashes or the RAG selector.
The dated execution status below separates those boundaries. The 72/100 intake
result in the [2026-09-11 quality audit](docs/quality-audit.md) is historical,
not a score for the present working tree.

### How to assess the evidence

- **Demonstrated (recorded release):** committed run/verification evidence exists
  for the named historical release, not a fresh live check.
- **Verified locally:** implementation or real-data checks exist, but do not
  prove that the same data is published or served by the hosted application.
- **Partial / source-constrained:** available records or a documented access
  limitation exist; the exact coverage and missing fields are stated.
- **Not demonstrated:** the required result is not supported by the available
  evidence. A plan, test fixture, or limitation note alone does not make it pass.

Documenting slow, inaccessible, policy-gated, and manual-only sources is part
of the assignment. BBB and contact details are conditional on availability;
year built is an explicitly permitted roof-age proxy. Neither a source-listed
contractor name nor a missing rating implies verified licensing, a legal-company
relationship, a bad rating, or absence of a contractor. Unexamined sources remain
unknown rather than being described as inaccessible.

### Which dataset is being assessed?

| Dataset / evidence boundary                                              | Properties |                                      Permits | Meaning                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------ | ---------: | -------------------------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recorded successful release, `20260910T225242Z`                          |    215,806 | 17,671 CD Plus source permits; 17,457 linked | The committed [public pointer](artifacts/latest.json) still names this historical release. It predates the Clermont contractor data and is not the selected hosted preview.                                                                                                                                                                       |
| Historical local candidate, `20260911T131000Z`                           |    215,806 |                                       21,732 | One-year Clermont candidate; not the full harvest or a public release. The documentation RAG's structured artifact selector still names this local candidate.                                                                                                                                                                                     |
| Full private query repair, `lake-query-repair-20260916t105553z`          |    215,806 |                                       76,166 | Real-data DuckDB/API/MCP checks are recorded in [the query repair](docs/lake-query-repair.md). This earlier query candidate is not an approval of the later conservative preview's permit decisions.                                                                                                                                              |
| Latest conservative private derivative / preview                         |    215,806 |  76,166: 72,187 linked; 3,979 valid unlinked | [Retained-evidence result](docs/lake-retained-evidence-repair.md). Original permit observations remain available, but current/open status, duration, primary-roof completion, and verified legal identity are not accepted conclusions.                                                                                                           |
| Frozen source-only export and hosted partial preview, `20260916T181000Z` |    215,806 |  76,166: 72,187 linked; 3,979 valid unlinked | Historical source facts, low-confidence built-year proxies and all 33,346 business accounts. Public primary imports and every-object two-host readbacks verified. Hosted run/coverage agree; successful publication promotion remains held for unproven independent retention. Unsupported current/open/completion/legal conclusions remain null. |
| Later integrated candidate, `20260917T152549Z`                           |    215,806 |  76,431: 72,450 linked; 3,981 valid unlinked | [Real incremental integration](artifacts/incremental-integration-20260917T152549Z.json): 265 inserts, 801 updates, all 58,495 Clermont records unchanged, new local root/manifest/CAR. Unpublished; not a second successful public run.                                                                                                           |

Hosted UI, REST, MCP, and agent endpoint:
[Lake County Oracle](https://tf2ynypdvfkv4dqxszpkj5emjq0imyxh.lambda-url.us-east-2.on.aws/).
The September 17 deployment replaces the old Claude-backed runtime with the
Vercel AI SDK/OpenAI implementation. Live metadata identifies the selected run
and its matching source-only coverage. The old mismatched metadata and
`undefined.length` blank-window fault were reproduced before deployment and
repaired with regression tests. This is a partial preview, not `FINALIZED`.

The recorded public root is
`bafybeigpkklcelrvukkwvor42wfmibmvwuveufwjspsumgmpbx3r26iowy`;
its manifest is
`bafkreigyltpgm7qxu7ccyfqeyg3q2c3ygdrqkgwnajjunrplv3xf32phmi`.
These are identities for the older successful release. The selected preview root is
`bafybeigakr7d6nywkbanzmh4r7cpv7kz7qs5vxvwlxcxuovk2lobrj442u`;
its [manifest](artifacts/manifest-20260916T181000Z.json) CID is
`bafkreiezsu6lbe7v43vv5hq26tp2ucojuajvpntapw2rn6fhntuq3oyopm`.
Use these CIDs as identities; gateway URLs are only locators.

### Source coverage and count grains

| Category / source                                                 | Available or retained evidence                                                                     | Loaded/queryable boundary and limitations                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Properties — Florida DOR NAL, 2026 preliminary                    | 215,806 assessed parcels                                                                           | One row per distinct folio, no null property keys in the local readback. NAL is the denominator, not the smaller GIS release.                                                                                                                                                                                                                                   |
| Ownership / available contact fields — NAL                        | Owner names and public mailing addresses; source catalog measures 215,620 parcels with owner names | Owner locality is derived and labelled. No invented phone/email contacts and no outbound owner messaging. This is not a ten-year chain of title.                                                                                                                                                                                                                |
| Sales — Florida DOR SDF / NAL                                     | 37,020 source sales; 30,977 parcels with a recorded sale in 2025–2026                              | Official appraiser pages advertise 2012–2026 annual sales and monthly all-years bulk data. The advertised FTP directory and a bounded direct annual-download probe returned managed-challenge 403 on normal routes. No older bytes were acquired; ten-year ownership tenure remains unproven.                                                                   |
| Businesses — Florida DOR TPP                                      | 33,346 source accounts, including 1,883 construction-class and 44 roofing-class NAICS accounts     | All 33,346 are queryable in the hosted preview through a typed business table, REST, MCP and Business view, including 31,286 valid unmatched accounts. 2,060 matched accounts attach to 2,726 properties via 4,451 candidate account–parcel attributions; these are not 4,451 businesses or verified legal identities. Raw payload/contact fields stay private. |
| Coordinates — Florida GIO, 2025 release                           | 210,935 source features; 209,503 property coordinate pairs retained                                | 6,303 assessed properties lack joined coordinates and remain in the data. Pairs come from one valid source row; centroids are source-backed parcel locations, not a claim of surveyed roof/GPS accuracy.                                                                                                                                                        |
| County permits — Lake CD Plus                                     | Frozen baseline: 17,671 distinct permits from 17,915 features                                      | Unincorporated Lake only; not complete county history. A later isolated refresh captured 1,118 features / 1,066 distinct permits, adding 265 and updating 801 permit–parcel associations. The fresh window is not yet published and does not confer fresh timestamps on older records. Contractor names are not exposed in this layer.                          |
| Municipal permits / available contractor names — Clermont eTRAKiT | 58,495 retained permits across all twelve 2015–2026 partitions                                     | Source-listed contractor/contact names and lifecycle observations are retained. Selected contractor-of-record exports and all-contact capture counters have different grains; names are not verified legal/license identities.                                                                                                                                  |
| Other permit jurisdictions                                        | The [source catalog](pipeline/docs/lake-sources.yaml) enumerates all 15 permitting authorities     | Thirteen municipalities have recorded blocked, unavailable, or manual-only routes. No records are asserted for an unacquired route; jurisdiction and predecessor-system history are not replaced by a county-wide zero.                                                                                                                                         |
| BBB / contractor ratings                                          | No approved BBB ratings ingested                                                                   | Default access returned 403; this is a policy/API constraint, not proof that BBB is universally unreachable. Null means unavailable enrichment, not a zero score.                                                                                                                                                                                               |
| Additional corporate/licensing identity                           | No adequate loaded Sunbiz/DBPR historical identity baseline established                            | Separate [kit-conformance difference](#official-kit-conformance-and-evaluation-handoff), not an extra express requirement to prove historical legal-business relationships in the assignment brief.                                                                                                                                                             |

Source endpoints, access evidence, jurisdiction routes, and period limits are in
[lake-sources.yaml](pipeline/docs/lake-sources.yaml). Raw captures, identity data,
private derivatives, and operator receipts stay outside Git. The counts above
are different grains: source accounts, attached entities, distinct permits,
property links, and artifact counts must not be summed interchangeably.

The conservative derivative has 169,007 valid actual-built-year roof proxies;
120,362 have a building-age proxy **at least 15 years** as of 2026-09-16.
These are not measured roof ages. Partial permit history may omit a replacement,
and no permit-backed primary-roof completion anchor is currently accepted.

### Execution of the approved stages 1–4 — 2026-09-17

1. **Public evidence:** all 40 listed objects plus the manifest itself have
   recorded two-host size/SHA-256 proof. The CAR's final check completed at
   `15:17:03 UTC`; the [combined inventory](artifacts/submission-gateway-inventory-20260917.json)
   links immutable observation receipts rather than inventing a new publish.
   Lighthouse metadata confirms registration, not completed independent retention;
   [the bounded retention check](artifacts/lighthouse-retention-check-20260917T151751Z.json)
   preserves that missing proof. Filecoin deals are not an added assignment gate.
2. **Real incremental integration:** the captured CD Plus window is now applied
   to a separate reproducible source-only packet. Actual Parquet comparisons prove
   265 inserts, 801 updates and 16,870 unchanged CD Plus records, not timestamp-only
   CID churn. All 58,495 Clermont records, all business bytes and the prior packet
   remain unchanged. The new local root differs and its multi-root CAR verifies
   all 1,353 blocks. [Integration evidence](artifacts/incremental-integration-20260917T152549Z.json)
   and [held manifest](artifacts/manifest-20260917T152549Z.held.json) explicitly say
   unpublished. Independent-retention uncertainty holds successful publication
   and IPNS/history promotion; the incremental public demonstration is unmet.
3. **Hosted stability and demonstration:** the selected source-only preview is
   deployed with explicitly bound run/root/coverage, guarded DuckDB access,
   worker cleanup, safe routing and the `undefined.length` render fix. The
   hosted walkthrough exercises real views and both roofing agent prompts.
   It is a partial demonstration, not a passed full-assignment demo. See
   [delivery handoff](docs/submission-handoff-20260917.md) for the recording,
   runtime identity, verification and exact missing outcomes.
4. **Submission handoff:** the owner approved pushing the local work to existing
   [PR #2](https://github.com/prismteam-ai/oracle-property-intelligence-platform-pipeline-lake-fl/pull/2)
   and updating its body. Commits are authored and committed only as `rarcifa`.
   The final Slowking review must identify the exact pushed head, hosted preview
   and video; no historical score is presented as a new result.

Local checks on 2026-09-16 passed: 484 application tests, 941 pipeline tests,
four retained transform tests and 100 responsive UI checks. The layout lane
used the previously approved isolated Chrome 152.0.7977.84 fallback; pinned
Chromium remained unavailable. Build, strict type checks, lint and formatting
passed. Legacy decision regressions explicitly select their corpus-bound
snapshot; source-only guards have separate synthetic tests. Real source-only
REST/MCP readback showed all 33,346 accounts, 31,286 unmatched accounts and
23,696 building-age proxies strictly older than 15 within five miles of the
chosen Clermont center. This is local data/query proof, not a hosted demo.

### Publication status and historical evidence

The bounded owner-approved replication reconciliation reached
`REPLICATION_REQUESTS_RECORDED`, revision 22, with all three Filebase imports
verified and all three Lighthouse registrations reconciled. No successful
history/IPNS/latest/RAG promotion occurred. Every selected manifest object now
has recorded two-host public proof; independent retention is still unproved.
Normal publication/replication no longer requires per-commit personal signing.

[The delivery handoff](docs/submission-handoff-20260917.md) supplies exact CIDs,
CAR digest/import instructions, immutable refresh evidence, provider hold and
cost/authority boundaries. [Historical provider/recovery attempts](docs/publication-history-20260917.md)
remain preserved separately and must not be mistaken for current readiness.
The existing owner-funded Lighthouse Lite US$12/month plan is the expressly
approved exception to the US$5/month storage ceiling; no new paid tier or
account is authorized. No provider key is committed or included in the RAG corpus.

## Every acceptance criterion: evidence and remaining proof

The identifiers below are a navigation checklist, not invented rubric weights.
Each row addresses a clause of the original brief. Conditional source constraints
are disclosed without turning them into an automatic failure or an automatic
pass. Remaining actions describe missing evidence; they do not authorize external
execution.

### Geography and data loading

| ID  | Brief requirement                                                          | Current status / evidence                                                                                                                                                                | Exact remaining proof or boundary                                                                                                                                                                                  |
| --- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| G1  | Lake County, FL is the default and primary geography                       | Observed hosted preview; Lake County / FIPS 12069 in matching coverage and live data                                                                                                     | Hosted demo remains partial; no reference-county fixtures.                                                                                                                                                         |
| L1  | Run until all available county data is uploaded                            | Partial; full assessed roll and Clermont 2015–2026 retained; [source and period boundaries](docs/lake-retained-evidence-repair.md)                                                       | Clearly separate accessible loaded data, constrained routes, unknown sources, and published data. No current all-county-complete claim.                                                                            |
| L2  | Load available property records                                            | Public CID-backed hosted preview: 215,806 properties; [chosen manifest](artifacts/manifest-20260916T181000Z.json)                                                                        | Successful publication promotion held; all assessed properties retained.                                                                                                                                           |
| L3  | Load available permits, emphasizing roofing                                | Hosted: 76,166 historical permits, including 58,495 Clermont; later local candidate 76,431                                                                                               | Current roofing classification remains unaccepted; no countywide permit-history claim.                                                                                                                             |
| L4  | Preserve status, open/close dates or equivalent, and duration-open signals | Observations preserved; current decision result not demonstrated; [decision contract](docs/lake-retained-evidence-repair.md)                                                             | Establish source-backed status/date/work-type semantics and an explicit as-of date for long-open results. Equivalent lifecycle fields are allowed; three separate closing dates are not an assignment requirement. |
| L5  | Load available ownership records                                           | Hosted NAL owner/mailing fields and owner-locality results                                                                                                                               | Owner mailing geography is not verified residency or a complete ownership history.                                                                                                                                 |
| L6  | Load available contractor records                                          | Hosted historical permit observations with Clermont source-listed names; [scope](packages/shared/src/honesty.ts)                                                                         | Not verified licenses/legal companies; names outside acquired jurisdiction remain unknown.                                                                                                                         |
| L7  | Load BBB / rating scores where publicly available                          | Source-constrained; no approved BBB enrichment, [access evidence](pipeline/docs/lake-sources.yaml)                                                                                       | Show missing ratings and the access reason; do not invent scores or require an indefinite wait for conditional enrichment.                                                                                         |
| L8  | Load available business records                                            | Hosted all 33,346 TPP accounts, including 31,286 valid unmatched accounts                                                                                                                | Account–parcel candidates are not verified legal companies or proof of permit work.                                                                                                                                |
| L9  | Load location/coordinates for radius queries                               | Hosted 209,503 coordinate pairs; actual five-mile radius query observed                                                                                                                  | 6,303 assessed properties have null joined coordinates and remain retained.                                                                                                                                        |
| L10 | Roof age or best-available proxies, configurable threshold (suggested 15)  | Hosted configurable built-year proxy; threshold 16 demonstrates strictly older than 15                                                                                                   | Low confidence, as-of 2026-09-16; not measured roof age, replacement history incomplete.                                                                                                                           |
| L11 | Reconcile duplicate entities across uploaded datasets                      | Partial / verified locally at property and permit grain; unique folios, stable permit identity, 72,187 links and 3,979 preserved unlinked records, [readback](docs/lake-query-repair.md) | Demonstrate cross-source matching and ambiguous/unmatched cases; address sharing or identical contractor names alone do not prove entity equality.                                                                 |
| L12 | Preserve source provenance                                                 | Hosted SQL/source/run/root provenance; immutable capture and export digests retained                                                                                                     | Unknown original observation times remain unknown; export time is not substituted.                                                                                                                                 |

### Continuous and incremental ingestion

| ID  | Brief requirement                                                                                 | Current status / evidence                                                                                                                       | Exact remaining proof or boundary                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | Ongoing new/changed ingestion: on-demand or scheduled, windows/change detection, idempotent steps | Real bounded capture and source-only integration: 265 inserts, 801 updates; [evidence](artifacts/incremental-integration-20260917T152549Z.json) | Later distinct-CID packet is local/unpublished; republish and matching successful history remain unmet.                                                                                  |
| I2  | Visible run history: timestamps, sources, counts, deltas and limitations                          | Demonstrated for recorded releases; [seven-run history](artifacts/run-history.json) and coverage snapshots                                      | Include the full retained dataset's later runs and surface matching history in the final run summary. Property row-hash deltas and other table row-count deltas are labelled separately. |
| I3  | Show ongoing ingestion/publishing through multiple runs or simulated updates                      | Actual changed-record later packet has new root/manifest/CAR, prior36 files unchanged                                                           | No second successful public publish; unchanged metadata alone is not claimed as data change.                                                                                             |

### Infrastructure and access

| ID  | Brief requirement                                 | Current status / evidence                                                                                                                                                          | Exact remaining proof or boundary                                                                                                             |
| --- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Optimize performance where feasible               | Measured bulk downloads/joins, bounded worker recovery and direct Parquet consolidation, [performance evidence](docs/cost.md)                                                      | Existing 2026-09-09–11 timings are historical benchmarks, not a promise of current full-harvest ETA.                                          |
| A2  | Identify slow/constrained sources                 | Demonstrated in discovery records; Clermont HTML is slow; managed challenges, manual-only routes, API policy and paging/IN-list limits, [catalog](pipeline/docs/lake-sources.yaml) | Keep constraints per source, jurisdiction and period; do not evade controls.                                                                  |
| A3  | Document speed limitations/source constraints     | Demonstrated as documentation; [cost/performance model](docs/cost.md) / [source catalog](pipeline/docs/lake-sources.yaml)                                                          | Carry these limitations into the final run coverage and presentation, not just this README.                                                   |
| A4  | No ongoing Oracle infrastructure cost by default  | Implemented design; consumer-side DuckDB, immutable files, optional owner-funded compute, [cost model](docs/cost.md)                                                               | Demonstrate consumer querying independently of the hosted demo. Pins, storage, model calls and optional hosting are not claimed free forever. |
| A5  | IPFS for eligible decentralized dataset artifacts | Chosen public CID imports and all-object readback recorded; [manifest](artifacts/manifest-20260916T181000Z.json)                                                                   | Independent retention and successful promotion remain held; no raw private captures published.                                                |
| A6  | DuckDB for local/portable analytics               | Real data queried by hosted DuckDB and portable local checks; [query layer](docs/lake-query-repair.md)                                                                             | Hosted Lambda is optional convenience, not a persistent hosted database.                                                                      |
| A7  | MCP-ready database structure                      | Ten hosted MCP tools over the same typed property/permit/business model                                                                                                            | Dataset information identifies the same selected run/root; unsupported conclusions are refused.                                               |
| A8  | Agent access to query the database                | Live AI SDK/OpenAI agent answered both roofing discovery prompts                                                                                                                   | Source-backed proxies available; open-roofing decision refused instead of invented results.                                                   |
| A9  | UI for exploring uploaded data                    | Live real-data UI views; blank-window fault fixed and regression-tested                                                                                                            | Final hosted partial recording includes console/blank checks; no full-assignment readiness claim.                                             |

### IPFS publication

| ID  | Brief requirement                                                                                                                   | Current status / evidence                                                                                                                                      | Exact remaining proof or boundary                                                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1  | CIDs are durable artifact identity; vendor URLs are locators                                                                        | Exact CID identities in [chosen manifest](artifacts/manifest-20260916T181000Z.json)                                                                            | Hosted preview root is distinct from older successful latest/IPNS pointer.                                                                             |
| P2  | Prefer CIDv1/base32 for every object                                                                                                | All chosen manifest objects use CIDv1/base32                                                                                                                   | Keep immutable identity; vendor URLs are locators.                                                                                                     |
| P3  | Public bytes survive local/demo teardown and loss of any single pin vendor                                                          | Not fully demonstrated; second-provider pin stage is implemented, [retention design](docs/cost.md) / [pin implementation](pipeline/src/core/secondary-pin.mjs) | Establish independent retention for the chosen objects. Two HTTP gateways alone do not prove independent pinning or survival after all pins disappear. |
| P4  | Per-run JSON manifest: every eligible object, logical name/path, CID, size, file/directory codec, digest; optional provider origins | Chosen complete manifest lists40 objects with path/CID/size/codec/digest                                                                                       | Manifest itself separately verified; optional provider origins omitted, not invented.                                                                  |
| P5  | If IPNS is used, retain both name and resolved run CID                                                                              | Demonstrated for recorded runs; [public pointer](artifacts/latest.json) / [history](artifacts/run-history.json)                                                | Record verified resolution for the new release. The single owned name is a mutable pointer, never the snapshot identity.                               |
| P6  | Incremental republish creates new CIDs, keeps prior bytes/CIDs/history immutable                                                    | Changed later Parquet data creates distinct local CIDs; previous packet unchanged                                                                              | Public incremental republish, prior-current public readback and new successful history remain unmet.                                                   |
| P7  | Publish a CAR of the DAG for each directory artifact                                                                                | Public snapshot.car contains all listed directory DAGs; full digest readback and offline block verification                                                    | Logical CAR is341,012,658 bytes, not root-only import transport or provider export.                                                                    |
| P8  | Fetch each listed CID via at least two independent public gateways; match size/digest                                               | All40 listed objects plus manifest have two-host size/digest matches; [inventory](artifacts/submission-gateway-inventory-20260917.json)                        | Proof aggregates dated standalone observations; not a FINALIZED receipt or independent retention proof.                                                |
| P9  | Include manifests and CARs in repository or demo packet for third-party retrieval                                                   | Committed chosen manifest and CID-addressed public CAR with retrieval instructions in [handoff](docs/submission-handoff-20260917.md)                           | Later held candidate manifest is committed but its CAR is private/unpublished, explicitly not delivered.                                               |

The gateway examples in the brief are examples, not a requirement to use only
ipfs.io or dweb.link. The recorded receipt used public Filebase and IPFS Lens
gateways; it does not verify every manifest object or establish today's
availability. Historical 429 responses and CORS/Range limitations are recorded
in the source/runbook evidence, not bypassed.

### Roofing CRM–supporting queries

| ID  | Brief requirement                                                  | Current status / evidence                                                                                                           | Exact remaining proof or boundary                                                                                                                                                        |
| --- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Radius search around GPS point/map pin                             | Hosted five-mile radius search returns actual properties, coordinates and SQL/run/source provenance                                 | Map/GPS interaction design is not scored as pipeline scope.                                                                                                                              |
| Q2  | Roof age over 15 or configurable threshold                         | Hosted strictly-over-15 search returns 23,696 building-age proxies within five miles of 28.5494, -81.7729                           | Threshold16 on integer ages; low-confidence built-year basis, not measured roof age.                                                                                                     |
| Q3  | Open roofing permits, especially long-open permits                 | Implemented filters, but not demonstrated by the current conservative preview; [preview guard](packages/server/src/data/queries.ts) | Accept defensible status/date/roofing semantics and demonstrate duration sorted long-open results. The preview currently refuses these filters rather than returning a false empty list. |
| Q4  | Permit details with contractor name and BBB rating where available | Hosted historical permit-grain observations and source-listed Clermont contractor names                                             | BBB unavailable/null, legal identity unverified; current-open classification remains refused.                                                                                            |
| Q5  | Properties without ownership exchange for more than 10 years       | Not demonstrated; inspected 2025–2026 sales cannot prove tenure, [sales boundary](pipeline/docs/lake-sources.yaml)                  | Use sufficiently historical official ownership evidence, or explicitly report this unmet question. no_recorded_sale_in_dor_window is not a ten-year tenure result.                       |
| Q6  | Regional/out-of-area owners                                        | Hosted Tenant view shows owner-mailing geography derived from NAL                                                                   | Out-of-area mailing address is a labelled proxy for locality, not verified residency.                                                                                                    |
| Q7  | Source-backed answers where source data is available               | Live views carry matching run/root, SQL and source provenance; agent record output is guarded                                       | Final video's aged-roof prompt abstains, so its NL property list is not demonstrated. Documentation RAG selector remains older local candidate, not parcel-row evidence.                 |

### Demonstration requirements

| ID  | Brief requirement                                          | Current status / evidence                                                               | Exact remaining proof or boundary                                                                                                                                       |
| --- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Demonstrate uploaded dataset through UI                    | Actual hosted partial-data walkthrough; [delivery](docs/submission-handoff-20260917.md) | Not a passed full-county/full-brief demonstration.                                                                                                                      |
| D2  | Demonstrate roofing-aligned agent query                    | Both original roofing prompts attempted through the live hosted agent                   | Final take records safe abstention for the aged-roof list and a pre-generation source-only refusal for current-open roofing. Neither is a fulfilled property lead list. |
| D3  | Demonstrate operation without Oracle infrastructure cost   | Portable read path implemented, [cost model](docs/cost.md)                              | Show consumer-side DuckDB/MCP access; identify who funds ongoing retention and optional demo operations.                                                                |
| D4  | Demonstrate public CID manifest plus independent retrieval | Every selected CID has public two-host proof; actual manifest/CAR available by CID      | Independent retention remains unproved; new incremental run remains unpublished.                                                                                        |
| D5  | Fulfill both Oracle and builder responsibilities           | Partial; ingestion, code, evidence and cost design exist                                | Tie collection/reconciliation/publication evidence and builder implementation/demo together. Do not claim fulfilled from code or a plan alone.                          |
| D6  | Pass demo using real uploaded Lake County records          | Real chosen Lake records served and recorded, not fixtures                              | Full demo remains unpassed because lifecycle, tenure, retention and incremental publication are unmet.                                                                  |

## Demo transcript: expected-result checklist

This follows the brief's opening claim and each expected result. It is a
recording checklist, not a claim that the beats have already passed. The
[recorder](packages/ui/scripts/record-demo.mjs) and
[demo script](docs/demo-script.md) now refuse stale/mismatched releases and
source-only packets that cannot demonstrate accepted current/open decisions.
They are execution checks, not evidence that the final demo has already passed.

| Step | Brief beat / expected result                                                                                        | Where to show it                                                                        | Current proof / missing proof                                                                            |
| ---- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| M0   | Opening: Lake data loaded, DuckDB queryable, immutable IPFS snapshots, UI and agent roofing discovery               | Selected source-only partial run; no all-county/FINALIZED claim                         | State partial scope and exact run/CID before presenting.                                                 |
| M1   | Completed run summary: sources, county coverage, counts, timestamps and limitations                                 | Hosted run/root/coverage agree; counts and limitations visible                          | Successful historical run history is preserved separately, not rewritten for preview.                    |
| M2   | Total uploaded records by property, permit, ownership, contractor/BBB, business and coordinate source               | Live counts conserve 215,806 properties/76,166 permits/33,346 businesses                | Source/entity/link grains preserved; unknown capture timestamps not fabricated.                          |
| M3   | DuckDB-backed structured querying with no Oracle-hosted database                                                    | Real DuckDB queries in UI and portable tooling                                          | Optional Lambda incurs owner usage costs; no hosted DB required.                                         |
| M4   | Manifest lists every eligible artifact, CID, size, logical name, codec, digest; IPNS name plus resolved CID if used | Committed chosen 40-object manifest, independently retrievable manifestCID              | Owned IPNS still names predecessor; preview does not pretend it was repointed.                           |
| M5   | Retrieve artifact by CID from two independent public gateways and verify matching bytes                             | All40+manifest recorded two-host matches including 341,012,658-byte CAR                 | Standalone observation reports are not promotion receipts.                                               |
| M6   | Later incremental publish changes CID, preserves prior CID; both in history; directory CAR available                | Actual later 265/801 window has changed local Parquet/CIDs and verified CAR             | Not demonstrated publicly; held packet is not an incremental successful publish.                         |
| M7   | UI radius query for roofs over 15: age basis, coordinates, provenance                                               | Real radius/age query, basis and provenance observed                                    | Strictly>15 uses integer threshold 16; low confidence/year-built proxy.                                  |
| M8   | UI long-open roofing permits: status, duration, contractor and BBB where present, source backing                    | Historical observations visible; current-open decisions explicitly unknown              | Open status/duration/roofing semantics remain unmet, not an empty list.                                  |
| M9   | Agent: “Which properties in Lake County within five miles of [city xyz] have roofs older than 15 years?”            | Original prompt recorded; guarded agent abstains when canonical rows cannot be verified | Expected NL property list remains unfulfilled; proxy results are demonstrated separately through the UI. |
| M10  | Agent: long-open nearby roofing permits and listed contractor                                                       | Original prompt records a pre-generation unsupported-source refusal                     | No current-open lead list; status/duration are unknown and BBB unavailable.                              |
| M11  | MCP-ready interface/model usable by agents and CRM without changing the data model                                  | Hosted ten-tool MCP contract and matching run/root                                      | No CRM data-model redesign required.                                                                     |

## Fixed remaining assignment work

1. Complete the chosen dataset's coverage/reconciliation account, including
   unmatched business records, constrained jurisdictions and unknown history.
2. Demonstrate defensible roofing-status/date/duration answers, allowed roof-age
   proxies, source-listed contractors, radius and owner-locality results. Resolve
   or explicitly retain the ten-year-tenure query as not demonstrated.
3. Bind that dataset to DuckDB, UI and agent/MCP and verify the reported browser
   stability issues against the actual release, not only mocked layout checks.
4. Demonstrate a bounded later refresh and complete CID-addressed publication:
   immutable history, every-object manifests/readbacks, directory CARs and
   independent retention that outlives the candidate environment.
5. Record the brief's demo beats and provide an accurate final evidence handoff.

These are the original outcomes, not new validation rounds. Documentation alone
does not implement the remaining work or promote private data.

## Run and verify locally

Use Node 22.18+ below 23 and pnpm 10, as pinned by [package.json](package.json).

```bash
pnpm install
pnpm run build
pnpm run start
```

The ordinary startup uses the configured/selected dataset. It does not
automatically select the newer private query repair. See
[server configuration](packages/server/README.md),
[deployment guide](docs/deploy.md) and [runbook](docs/runbook.md).
The opt-in conservative evidence preview is loopback/private-only, is not a
submission deployment, and intentionally refuses unsupported open/completion
filters. Public-model chat needs an operator-provided key; never commit it.

Normal implementation checks:

```bash
pnpm run build
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm run test
npm test --prefix pipeline
pnpm --dir infra run synth
```

Latest dated evidence: [query-only real-data checks](docs/lake-query-repair.md),
[conservative derivative replay/tests](docs/lake-retained-evidence-repair.md),
and [raw-observation extractor scope](docs/lake-retained-observation-extractor.md).
These are different verification scopes, not interchangeable release receipts.

### Official kit conformance and evaluation handoff

Agents and skills come from the globally installed official
`soofi-xyz-team-kit@soofi-xyz-team-kit` Codex plugin; they are not copied here.
`pipeline/` is retained Lake-specific runtime code, not a second skill install.
See [AGENTS.md](AGENTS.md), [kit differences](pipeline/docs/lake-kit-deviations.md)
and [observability handoff](docs/observability-handoff.md).

The current official kit additionally mandates Sunbiz then an adequate dated
DBPR identity baseline before permit harvesting, and temporal proof before
verified historical legal-company attribution. That conformance is **not**
established for the retained permit-first history. DOR TPP is not a substitute
for a corporate/licensing baseline. This README neither invents a waiver nor
claims full kit compliance; those differences are separate from the brief's
available source-listed contractor-name requirement. No DBPR request has been
submitted as part of this documentation change.

Slowking's evaluator also checks the actual submission/runtime and its handoff,
including the designated PR, hosted experience, credential availability and
demo video. This README supplies an evidence map; it cannot override the
evaluator's rules or guarantee a score. The final existing-PR description,
README, runtime run/CID, manifests and video must all identify the same release.
Private local edits are not proof that the remote PR already contains them.

The [quality audit](docs/quality-audit.md) is dated 2026-09-11;
[runbook](docs/runbook.md), [cost benchmarks](docs/cost.md) and
[demo script](docs/demo-script.md) contain historical pre-full-harvest details.
Their old one-year counts, baseline warnings, roof/status conclusions and
contractor-absence wording are not current claims. Use the dated repair
boundaries and the exact artifact identity, not whichever document looks newest.
The RAG index's structured selected run remains the older local candidate;
new README prose has repository provenance, not that run's artifact/CID
provenance or a promotion to the full retained dataset.

### Out of scope

The pipeline exposes data and query interfaces for the
[Roofing CRM](https://github.com/prismteam-ai/roofing-crm).
Roofing CRM workflow, map-pin/GPS interaction design and lead outreach are not
implemented as assignment requirements here. Live outbound messaging to owners
is out of scope. The required data-exploration UI is not a replacement CRM.

### Assignment references

- [Roofing CRM & Lead Identification UI](https://github.com/prismteam-ai/roofing-crm):
  downstream consumer and scope boundary.
- [Soofi XYZ Team Kit](https://github.com/soofi-xyz/soofi-xyz-team-kit):
  official agents, engineering conventions and evaluator.
- [Elephant Oracle Skills](https://github.com/elephant-xyz/skills):
  Lexicon/elephant-cli/Filebase+IPNS ingestion/publication conventions.

The brief below remains the source text; this implementation evidence layer
does not change it.

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
