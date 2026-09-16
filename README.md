# Oracle Property Intelligence Platform Pipeline - Lake County, FL

## Assignment evidence — 2026-09-16

This is the Lake County ingestion pipeline, not the Roofing CRM or an outreach
application. The [original assignment brief](#original-assignment-brief) below is
preserved in full. The implementation and evidence map follows that brief:
available data, reconciliation, incremental operation, portable DuckDB access,
roofing queries, public immutable IPFS artifacts, and a real-data demonstration.

The repository has a working architecture and substantial real data. The full
Clermont 2015–2026 harvest is retained; it has **not** been started over. The
latest private dataset has **215,806 properties and 76,166 permits**, but that is
not the dataset in the recorded public release. County-wide completeness and a
final public demonstration are not established.

This page describes the implementation in this branch. A code commit does not
publish a dataset, upgrade the hosted runtime, or complete the demo. The dated
execution status below separates those boundaries. No new
Slowking evaluation has been run for these repairs. The 72/100 intake
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

| Dataset / evidence boundary                                     | Properties |                                      Permits | Meaning                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------- | ---------: | -------------------------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Recorded public release, `20260910T225242Z`                     |    215,806 | 17,671 CD Plus source permits; 17,457 linked | The committed [public pointer](artifacts/latest.json) names this release. It predates the Clermont contractor data and exposes property permit aggregates. Current hosted availability was not rechecked for this README.                                                                  |
| Historical local candidate, `20260911T131000Z`                  |    215,806 |                                       21,732 | One-year Clermont candidate; not the full harvest or a public release. The documentation RAG's structured artifact selector still names this local candidate.                                                                                                                              |
| Full private query repair, `lake-query-repair-20260916t105553z` |    215,806 |                                       76,166 | Real-data DuckDB/API/MCP checks are recorded in [the query repair](docs/lake-query-repair.md). This earlier query candidate is not an approval of the later conservative preview's permit decisions.                                                                                       |
| Latest conservative private derivative / preview                |    215,806 |  76,166: 72,187 linked; 3,979 valid unlinked | [Retained-evidence result](docs/lake-retained-evidence-repair.md). Original permit observations remain available, but current/open status, duration, primary-roof completion, and verified legal identity are not accepted conclusions.                                                    |
| Separate source-only export, `20260916T181000Z`, local only     |    215,806 |  76,166: 72,187 linked; 3,979 valid unlinked | Newly projected historical source facts, valid low-confidence built-year proxies and a separate 33,346-account business table. Not the private unaccepted derivative; unsupported current/open/completion/legal conclusions remain null. No public CID or hosted promotion is established. |

Previously deployed UI, REST, MCP, and agent endpoint:
[Lake County Oracle](https://tf2ynypdvfkv4dqxszpkj5emjq0imyxh.lambda-url.us-east-2.on.aws/).
Live readback on 2026-09-16 found run `20260911T121542Z`, while its coverage
described `20260910T225242Z`. It is stale and mismatched, not the full retained
dataset or the final submission release. An empty app root was also reproduced.

The recorded public root is
`bafybeigpkklcelrvukkwvor42wfmibmvwuveufwjspsumgmpbx3r26iowy`;
its manifest is
`bafkreigyltpgm7qxu7ccyfqeyg3q2c3ygdrqkgwnajjunrplv3xf32phmi`.
These are identities for the older release, not for the 76,166-permit derivative.
The newer private query repair and derivative have no established public CID.

### Source coverage and count grains

| Category / source                                                 | Available or retained evidence                                                                     | Loaded/queryable boundary and limitations                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Properties — Florida DOR NAL, 2026 preliminary                    | 215,806 assessed parcels                                                                           | One row per distinct folio, no null property keys in the local readback. NAL is the denominator, not the smaller GIS release.                                                                                                                                                                                                                         |
| Ownership / available contact fields — NAL                        | Owner names and public mailing addresses; source catalog measures 215,620 parcels with owner names | Owner locality is derived and labelled. No invented phone/email contacts and no outbound owner messaging. This is not a ten-year chain of title.                                                                                                                                                                                                      |
| Sales — Florida DOR SDF / NAL                                     | 37,020 source sales; 30,977 parcels with a recorded sale in 2025–2026                              | Official appraiser pages advertise 2012–2026 annual sales and monthly all-years bulk data. The advertised FTP directory and a bounded direct annual-download probe returned managed-challenge 403 on normal routes. No older bytes were acquired; ten-year ownership tenure remains unproven.                                                         |
| Businesses — Florida DOR TPP                                      | 33,346 source accounts, including 1,883 construction-class and 44 roofing-class NAICS accounts     | All 33,346 are now queryable locally through a typed business table, REST, MCP and Business view, including 31,286 valid unmatched accounts. 2,060 matched accounts attach to 2,726 properties via 4,451 candidate account–parcel attributions; these are not 4,451 businesses or verified legal identities. Raw payload/contact fields stay private. |
| Coordinates — Florida GIO, 2025 release                           | 210,935 source features; 209,503 property coordinate pairs retained                                | 6,303 assessed properties lack joined coordinates and remain in the data. Pairs come from one valid source row; centroids are source-backed parcel locations, not a claim of surveyed roof/GPS accuracy.                                                                                                                                              |
| County permits — Lake CD Plus                                     | Frozen baseline: 17,671 distinct permits from 17,915 features                                      | Unincorporated Lake only; not complete county history. A later isolated refresh captured 1,118 features / 1,066 distinct permits, adding 265 and updating 801 permit–parcel associations. The fresh window is not yet published and does not confer fresh timestamps on older records. Contractor names are not exposed in this layer.                |
| Municipal permits / available contractor names — Clermont eTRAKiT | 58,495 retained permits across all twelve 2015–2026 partitions                                     | Source-listed contractor/contact names and lifecycle observations are retained. Selected contractor-of-record exports and all-contact capture counters have different grains; names are not verified legal/license identities.                                                                                                                        |
| Other permit jurisdictions                                        | The [source catalog](pipeline/docs/lake-sources.yaml) enumerates all 15 permitting authorities     | Thirteen municipalities have recorded blocked, unavailable, or manual-only routes. No records are asserted for an unacquired route; jurisdiction and predecessor-system history are not replaced by a county-wide zero.                                                                                                                               |
| BBB / contractor ratings                                          | No approved BBB ratings ingested                                                                   | Default access returned 403; this is a policy/API constraint, not proof that BBB is universally unreachable. Null means unavailable enrichment, not a zero score.                                                                                                                                                                                     |
| Additional corporate/licensing identity                           | No adequate loaded Sunbiz/DBPR historical identity baseline established                            | Separate [kit-conformance difference](#official-kit-conformance-and-evaluation-handoff), not an extra express requirement to prove historical legal-business relationships in the assignment brief.                                                                                                                                                   |

Source endpoints, access evidence, jurisdiction routes, and period limits are in
[lake-sources.yaml](pipeline/docs/lake-sources.yaml). Raw captures, identity data,
private derivatives, and operator receipts stay outside Git. The counts above
are different grains: source accounts, attached entities, distinct permits,
property links, and artifact counts must not be summed interchangeably.

The conservative derivative has 169,007 valid actual-built-year roof proxies;
120,362 have a building-age proxy **at least 15 years** as of 2026-09-16.
These are not measured roof ages. Partial permit history may omit a replacement,
and no permit-backed primary-roof completion anchor is currently accepted.

### Execution of steps 1–4 — 2026-09-16

1. **Data/query work:** the separate source-only packet contains 215,806
   properties, 76,166 historical permits and all 33,346 business accounts.
   Historical contractor observations, including unlinked permits, are
   explorable without implying current/open status or verified legal identity.
   Ten-year ownership tenure remains an explicitly unmet, access-constrained
   query; a two-year sales window is not a substitute.
2. **Incremental/publication work:** an actual on-demand CD Plus refresh
   completed at `2026-09-16T18:05:22.523Z`; its sanitized
   [readback](artifacts/refresh-20260916T180522Z.json) records 265 inserted and
   801 updated associations, excluding derived-age drift, with idempotent
   reconciliation. The publisher now checks every listed CID, including raw
   directory blocks, and delivers an actual CID-addressed multi-root CAR with
   complete offline DAG verification. These repairs do not retrospectively
   certify older publications or publish the new packet.
3. **Stability/demo work:** replacement sources now claim exclusive DuckDB
   worker ownership; an uncaught render error produces a visible recovery
   panel rather than an empty window. The recorder checks coverage/run identity,
   all-account business availability, ten MCP tools, live every-CID retrieval,
   delivered CARs, changed incremental query bytes, prior-byte retrieval,
   both roofing agent prompts, and console/blank failures. Tests are local;
   the old hosted runtime has not received these fixes and no final video exists.
4. **Submission handoff:** use the existing
   [PR #2](https://github.com/prismteam-ai/oracle-property-intelligence-platform-pipeline-lake-fl/pull/2).
   Commit authorship is `rarcifa` only. Its body must distinguish tested code
   from published data and the deployed release. Final Slowking evaluation
   awaits the actual matching hosted release and demo, not a local-only score.

Local checks on 2026-09-16 passed: 484 application tests, 892 pipeline tests,
four retained transform tests and 100 responsive UI checks. The layout lane
used the previously approved isolated Chrome 152.0.7977.84 fallback; pinned
Chromium remained unavailable. Build, strict type checks, lint and formatting
passed. Legacy decision regressions explicitly select their corpus-bound
snapshot; source-only guards have separate synthetic tests. Real source-only
REST/MCP readback showed all 33,346 accounts, 31,286 unmatched accounts and
23,696 building-age proxies strictly older than 15 within five miles of the
chosen Clermont center. This is local data/query proof, not a hosted demo.

Publication is blocked on an absent scoped Pinata JWT and trusted exact-byte
authorization. Authenticated Filebase readback also found the existing IPNS
pointer at sequence 13, root
`bafybeieiswif55i4ofj7saucyzhak23uim4shipijfdkvwhfcjrp2zaq7y`,
but committed successful history ends at `20260910T225242Z`. Remote CAR object
existence is not an original successful-publication receipt. Arceus requires
verified predecessor handoff/recovery before promotion; the predecessor guard
has not been bypassed and history has not been rewritten. The remote manifest
`bafkreihujmyavnl3esbsvcfezl35a67lmmfxf3orxhppwjb7ylszidnlpq`
was recovered from Filebase and IPFS Lens with matching 9,041 bytes / SHA-256
`f44b300ab57b24832a88a4caf7d07beb630b72edd1b9defb243fc2e5940dab7c`;
this proves that manifest's current retrieval, not its missing original approval
or every artifact's historical verification. Hosted agent chat
also needs the OpenAI credential configured in its cloud secret; the currently
deployed Lambda has no configured OpenAI secret. No new accounts, paid upgrades,
full harvest restarts, pruning, or new submission PRs are implied.

## Every acceptance criterion: evidence and remaining proof

The identifiers below are a navigation checklist, not invented rubric weights.
Each row addresses a clause of the original brief. Conditional source constraints
are disclosed without turning them into an automatic failure or an automatic
pass. Remaining actions describe missing evidence; they do not authorize external
execution.

### Geography and data loading

| ID  | Brief requirement                                                          | Current status / evidence                                                                                                                                                                                 | Exact remaining proof or boundary                                                                                                                                                                                  |
| --- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| G1  | Lake County, FL is the default and primary geography                       | Verified locally; county `lake`, FIPS `12069` in the [source catalog](pipeline/docs/lake-sources.yaml) and [runtime](packages/server/src/config.ts)                                                       | The final UI/agent demonstration must use this county, not reference-county fixtures.                                                                                                                              |
| L1  | Run until all available county data is uploaded                            | Partial; full assessed roll and Clermont 2015–2026 retained; [source and period boundaries](docs/lake-retained-evidence-repair.md)                                                                        | Clearly separate accessible loaded data, constrained routes, unknown sources, and published data. No current all-county-complete claim.                                                                            |
| L2  | Load available property records                                            | Verified locally and recorded in the older public release; 215,806 distinct properties, [readback](docs/lake-query-repair.md) / [history](artifacts/run-history.json)                                     | Serve that same chosen dataset in the final demonstration.                                                                                                                                                         |
| L3  | Load available permits, emphasizing roofing                                | Verified locally for 76,166 retained permits; [permit-grain result](docs/lake-retained-evidence-repair.md)                                                                                                | Publish/integrate the full retained table and demonstrate defensible roofing classification; CD Plus and municipal history limits remain explicit.                                                                 |
| L4  | Preserve status, open/close dates or equivalent, and duration-open signals | Observations preserved; current decision result not demonstrated; [decision contract](docs/lake-retained-evidence-repair.md)                                                                              | Establish source-backed status/date/work-type semantics and an explicit as-of date for long-open results. Equivalent lifecycle fields are allowed; three separate closing dates are not an assignment requirement. |
| L5  | Load available ownership records                                           | Verified locally; NAL owner/mailing fields and [owner query implementation](packages/server/src/data/queries.ts)                                                                                          | Demonstrate the available owner fields without claiming a complete ownership history.                                                                                                                              |
| L6  | Load available contractor records                                          | Partial / source-constrained; Clermont names retained, [contractor boundaries](packages/shared/src/honesty.ts)                                                                                            | Display source-listed names with permit provenance and jurisdiction scope. Historical verified legal-company relationships are not established or required as an express brief clause.                             |
| L7  | Load BBB / rating scores where publicly available                          | Source-constrained; no approved BBB enrichment, [access evidence](pipeline/docs/lake-sources.yaml)                                                                                                        | Show missing ratings and the access reason; do not invent scores or require an indefinite wait for conditional enrichment.                                                                                         |
| L8  | Load available business records                                            | Verified locally: all 33,346 account-grain records, including 31,286 unmatched, through [typed business queries](packages/shared/src/businesses.ts) and REST/MCP/UI                                       | Publish/serve the same account table in the final demonstration. Distinguish source accounts from candidate parcel associations and verified legal companies.                                                      |
| L9  | Load location/coordinates for radius queries                               | Verified locally; 209,503 intact coordinate pairs, [readback](docs/lake-query-repair.md)                                                                                                                  | Demonstrate the radius result and source location basis; keep missing coordinates null rather than dropping properties.                                                                                            |
| L10 | Roof age or best-available proxies, configurable threshold (suggested 15)  | Verified locally for actual-built-year proxies; [proxy result](docs/lake-retained-evidence-repair.md)                                                                                                     | Show basis, confidence, as-of date, configurable threshold and incomplete-history caveat. Do not call building age measured roof age.                                                                              |
| L11 | Reconcile duplicate entities across uploaded datasets                      | Partial / verified locally at property and permit grain; unique folios, stable permit identity, 72,187 links and 3,979 preserved unlinked records, [readback](docs/lake-query-repair.md)                  | Demonstrate cross-source matching and ambiguous/unmatched cases; address sharing or identical contractor names alone do not prove entity equality.                                                                 |
| L12 | Preserve source provenance                                                 | Verified locally; original observations, IDs, URLs, source/configuration and byte digests, [query provenance](docs/lake-query-repair.md) / [derivative provenance](docs/lake-retained-evidence-repair.md) | The final tables, UI and agent citations must identify the exact chosen run. Unknown per-record observation time stays unknown; export/certification time is not substituted.                                      |

### Continuous and incremental ingestion

| ID  | Brief requirement                                                                                 | Current status / evidence                                                                                                                                                         | Exact remaining proof or boundary                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | Ongoing new/changed ingestion: on-demand or scheduled, windows/change detection, idempotent steps | Verified locally: actual bounded CD Plus refresh with 265 inserted / 801 updated associations and idempotent readback, [refresh receipt](artifacts/refresh-20260916T180522Z.json) | Integrate and republish the later snapshot with a distinct CID and matching history. No permanently hosted scheduler is required; this receipt alone is not publication proof.                                                                |
| I2  | Visible run history: timestamps, sources, counts, deltas and limitations                          | Demonstrated for recorded releases; [seven-run history](artifacts/run-history.json) and coverage snapshots                                                                        | Include the full retained dataset's later runs and surface matching history in the final run summary. Property row-hash deltas and other table row-count deltas are labelled separately.                                                      |
| I3  | Show ongoing ingestion/publishing through multiple runs or simulated updates                      | Historical evidence; three incremental-mode releases report zero property deltas; a later full run records 195 property updates, [history](artifacts/run-history.json)            | Demonstrate a later update with truthful deltas and new immutable artifacts for the final dataset. If simulated, label it as such and preserve the real Lake baseline. A changed metadata CID alone is not proof of changed property records. |

### Infrastructure and access

| ID  | Brief requirement                                 | Current status / evidence                                                                                                                                                          | Exact remaining proof or boundary                                                                                                                           |
| --- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Optimize performance where feasible               | Measured bulk downloads/joins, bounded worker recovery and direct Parquet consolidation, [performance evidence](docs/cost.md)                                                      | Existing 2026-09-09–11 timings are historical benchmarks, not a promise of current full-harvest ETA.                                                        |
| A2  | Identify slow/constrained sources                 | Demonstrated in discovery records; Clermont HTML is slow; managed challenges, manual-only routes, API policy and paging/IN-list limits, [catalog](pipeline/docs/lake-sources.yaml) | Keep constraints per source, jurisdiction and period; do not evade controls.                                                                                |
| A3  | Document speed limitations/source constraints     | Demonstrated as documentation; [cost/performance model](docs/cost.md) / [source catalog](pipeline/docs/lake-sources.yaml)                                                          | Carry these limitations into the final run coverage and presentation, not just this README.                                                                 |
| A4  | No ongoing Oracle infrastructure cost by default  | Implemented design; consumer-side DuckDB, immutable files, optional owner-funded compute, [cost model](docs/cost.md)                                                               | Demonstrate consumer querying independently of the hosted demo. Pins, storage, model calls and optional hosting are not claimed free forever.               |
| A5  | IPFS for eligible decentralized dataset artifacts | Historical publication recorded; [manifest](artifacts/manifest-20260910T225242Z.json)                                                                                              | Publish the chosen new dataset under an exact approved release and prove retention/public retrieval. Private captures are not public dataset artifacts.     |
| A6  | DuckDB for local/portable analytics               | Verified locally on real full retained data; [91 API/MCP/DuckDB checks](docs/lake-query-repair.md)                                                                                 | Demonstrate the final artifacts in DuckDB without an Oracle-hosted database dependency.                                                                     |
| A7  | MCP-ready database structure                      | Implemented typed property/permit views and read-only query schema; [server interface](packages/server/README.md)                                                                  | Show the chosen data through the same documented model and MCP tools; no CRM redesign is needed.                                                            |
| A8  | Agent access to query the database                | Implemented OpenAI/Vercel AI SDK tool-backed agent plus MCP, [server interface](packages/server/README.md)                                                                         | A successful real-model answer against the full repaired dataset is not demonstrated by key-free MCP tests.                                                 |
| A9  | UI for exploring uploaded data                    | Implemented React search, detail, Tenant/Business/Contractor views and SQL explorer; [UI sources](packages/ui/src/views)                                                           | Demonstrate the chosen published data, not mocked layout tests or the stale hosted release; address reported console/black-window issues during that check. |

### IPFS publication

| ID  | Brief requirement                                                                                                                   | Current status / evidence                                                                                                                                      | Exact remaining proof or boundary                                                                                                                                                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | CIDs are durable artifact identity; vendor URLs are locators                                                                        | Implemented; CID fields in [manifests](artifacts/manifest-20260910T225242Z.json) and [run history](artifacts/run-history.json)                                 | Cite the exact snapshot CID; never substitute an S3 object, dashboard or gateway URL as the identity.                                                                                                                                                                 |
| P2  | Prefer CIDv1/base32 for every object                                                                                                | Demonstrated in the recorded manifest; [CID implementation](pipeline/src/core/cid.mjs)                                                                         | The final manifest must retain CIDv1 for every eligible object.                                                                                                                                                                                                       |
| P3  | Public bytes survive local/demo teardown and loss of any single pin vendor                                                          | Not fully demonstrated; second-provider pin stage is implemented, [retention design](docs/cost.md) / [pin implementation](pipeline/src/core/secondary-pin.mjs) | Establish independent retention for the chosen objects. Two HTTP gateways alone do not prove independent pinning or survival after all pins disappear.                                                                                                                |
| P4  | Per-run JSON manifest: every eligible object, logical name/path, CID, size, file/directory codec, digest; optional provider origins | Demonstrated format for the older release; its [manifest](artifacts/manifest-20260910T225242Z.json) lists 33 objects                                           | Build the complete final inventory: tables, coverage, indexes, extracts, and directory roots. Provider multiaddrs are optional when no candidate-operated node is serving; do not invent them. Directory digests describe DAG bytes, not a gateway HTML listing.      |
| P5  | If IPNS is used, retain both name and resolved run CID                                                                              | Demonstrated for recorded runs; [public pointer](artifacts/latest.json) / [history](artifacts/run-history.json)                                                | Record verified resolution for the new release. The single owned name is a mutable pointer, never the snapshot identity.                                                                                                                                              |
| P6  | Incremental republish creates new CIDs, keeps prior bytes/CIDs/history immutable                                                    | Historical distinct roots and run identities recorded; [history](artifacts/run-history.json)                                                                   | Demonstrate prior and new artifacts still retrieve, with truthful data deltas. Retaining identifiers alone is not a current prior-byte readback.                                                                                                                      |
| P7  | Publish a CAR of the DAG for each directory artifact                                                                                | CAR generation implemented; [CAR code](pipeline/src/core/car.mjs)                                                                                              | Actual delivered, retrievable CARs rooted at each listed directory CID are not established here. The legacy carCid equals rootCid and the format=car locator alone are not delivery/import proof.                                                                     |
| P8  | Fetch each listed CID via at least two independent public gateways; match size/digest                                               | Partial recorded proof; [verification receipt](artifacts/verification-20260910T225242Z.json) has 10 entries including the manifest                             | Only 9 of the manifest's 33 listed objects have matching verified CID entries; 24 are uncovered (21 shard files and 3 directories). Verify every final listed CID through two independent public gateways, with byte-size/digest semantics appropriate to files/DAGs. |
| P9  | Include manifests and CARs in repository or demo packet for third-party retrieval                                                   | Manifest/history/receipts are committed in [artifacts](artifacts); complete CAR packet not demonstrated                                                        | Deliver the final manifests and CARs, including exact retrieval/import instructions. A private operator path is not an evaluator-accessible packet.                                                                                                                   |

The gateway examples in the brief are examples, not a requirement to use only
ipfs.io or dweb.link. The recorded receipt used public Filebase and IPFS Lens
gateways; it does not verify every manifest object or establish today's
availability. Historical 429 responses and CORS/Range limitations are recorded
in the source/runbook evidence, not bypassed.

### Roofing CRM–supporting queries

| ID  | Brief requirement                                                  | Current status / evidence                                                                                                                                                  | Exact remaining proof or boundary                                                                                                                                                        |
| --- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Radius search around GPS point/map pin                             | Implemented great-circle distance and coordinate filters; [shared SQL](packages/shared/src/sql.ts)                                                                         | Demonstrate actual property results for a chosen center/radius with coordinates and provenance. Pin/GPS interaction design is out of scope.                                              |
| Q2  | Roof age over 15 or configurable threshold                         | Verified locally for built-year proxy, [derivative result](docs/lake-retained-evidence-repair.md)                                                                          | Show the basis and missing-data caveat; distinguish strictly greater than 15 from an at-least-15 filter.                                                                                 |
| Q3  | Open roofing permits, especially long-open permits                 | Implemented filters, but not demonstrated by the current conservative preview; [preview guard](packages/server/src/data/queries.ts)                                        | Accept defensible status/date/roofing semantics and demonstrate duration sorted long-open results. The preview currently refuses these filters rather than returning a false empty list. |
| Q4  | Permit details with contractor name and BBB rating where available | Partial; permit-grain and source-listed Clermont names are retained, [evidence contract](docs/lake-retained-evidence-repair.md) / [MCP surface](packages/server/README.md) | Show permit/source name details without claiming verified license/legal identity; explain conditional null BBB fields.                                                                   |
| Q5  | Properties without ownership exchange for more than 10 years       | Not demonstrated; inspected 2025–2026 sales cannot prove tenure, [sales boundary](pipeline/docs/lake-sources.yaml)                                                         | Use sufficiently historical official ownership evidence, or explicitly report this unmet question. no_recorded_sale_in_dor_window is not a ten-year tenure result.                       |
| Q6  | Regional/out-of-area owners                                        | Implemented owner-mailing locality derivation; [owner query](packages/server/src/data/queries.ts)                                                                          | Demonstrate the locality basis and available owner fields; mailing geography is not verified residency.                                                                                  |
| Q7  | Source-backed answers where source data is available               | Implemented SQL/run/source/parcel provenance, [query layer](packages/server/src/data/queries.ts)                                                                           | Show UI and agent answers bound to the same exact dataset, and abstain on unsupported parts. Documentation RAG is not a substitute for querying parcel rows.                             |

### Demonstration requirements

| ID  | Brief requirement                                          | Current status / evidence                                                                                                                        | Exact remaining proof or boundary                                                                                                              |
| --- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Demonstrate uploaded dataset through UI                    | UI implemented; final full-data demonstration not established, [existing demo script](docs/demo-script.md)                                       | Record the final chosen hosted dataset and visible source limitations.                                                                         |
| D2  | Demonstrate roofing-aligned agent query                    | Agent implemented; repaired-data model answer not demonstrated, [server interface](packages/server/README.md)                                    | Execute both roofing discovery prompts with source-backed results and explicit assumptions/missing fields.                                     |
| D3  | Demonstrate operation without Oracle infrastructure cost   | Portable read path implemented, [cost model](docs/cost.md)                                                                                       | Show consumer-side DuckDB/MCP access; identify who funds ongoing retention and optional demo operations.                                       |
| D4  | Demonstrate public CID manifest plus independent retrieval | Partial historical receipts, [manifest](artifacts/manifest-20260910T225242Z.json) / [verification](artifacts/verification-20260910T225242Z.json) | Complete final all-object two-gateway and portable CAR proof, rather than showing private-only access.                                         |
| D5  | Fulfill both Oracle and builder responsibilities           | Partial; ingestion, code, evidence and cost design exist                                                                                         | Tie collection/reconciliation/publication evidence and builder implementation/demo together. Do not claim fulfilled from code or a plan alone. |
| D6  | Pass demo using real uploaded Lake County records          | Real retained records verified locally; final uploaded/demo state not established, [query readback](docs/lake-query-repair.md)                   | Use real selected Lake records throughout; no fixtures, old CIDs or stale video can stand in for the final dataset.                            |

## Demo transcript: expected-result checklist

This follows the brief's opening claim and each expected result. It is a
recording checklist, not a claim that the beats have already passed. The
[recorder](packages/ui/scripts/record-demo.mjs) and
[demo script](docs/demo-script.md) now refuse stale/mismatched releases and
source-only packets that cannot demonstrate accepted current/open decisions.
They are execution checks, not evidence that the final demo has already passed.

| Step | Brief beat / expected result                                                                                        | Where to show it                                                                                | Current proof / missing proof                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| M0   | Opening: Lake data loaded, DuckDB queryable, immutable IPFS snapshots, UI and agent roofing discovery               | State the chosen run and scope before presenting                                                | Full local records exist; do not announce all-county completion or final-public readiness before their evidence exists.             |
| M1   | Completed run summary: sources, county coverage, counts, timestamps and limitations                                 | /api/meta/run and visible run/coverage summary; [history](artifacts/run-history.json)           | Historical history exists; final summary must match the full chosen dataset and distinguish constrained/unknown sources.            |
| M2   | Total uploaded records by property, permit, ownership, contractor/BBB, business and coordinate source               | /api/stats, coverage and source-count table                                                     | Preserve source/entity/link grains and actual collection timestamps; unknown observation time cannot become a fabricated timestamp. |
| M3   | DuckDB-backed structured querying with no Oracle-hosted database                                                    | UI SQL explorer and consumer-side DuckDB                                                        | Local real-data checks exist; demonstrate the chosen final artifacts rather than relying on a mock or remote database.              |
| M4   | Manifest lists every eligible artifact, CID, size, logical name, codec, digest; IPNS name plus resolved CID if used | Final manifest JSON and run pointer                                                             | Older manifest format exists; final inventory/identity must be supplied without borrowing old CIDs.                                 |
| M5   | Retrieve artifact by CID from two independent public gateways and verify matching bytes                             | Gateway fetch plus recorded size/digest result                                                  | Selected historical objects passed; repeat for every final listed CID, not just a vendor dashboard.                                 |
| M6   | Later incremental publish changes CID, preserves prior CID; both in history; directory CAR available                | Two run manifests/history, public readbacks and CAR packet                                      | Historical runs exist; demonstrate actual later data or labelled simulation and deliver CARs.                                       |
| M7   | UI radius query for roofs over 15: age basis, coordinates, provenance                                               | Search/detail views, chosen center and radius                                                   | Built-year proxy is allowed; show threshold/basis and partial-history caveat.                                                       |
| M8   | UI long-open roofing permits: status, duration, contractor and BBB where present, source backing                    | Contractor/search views and permit detail                                                       | Current preview blocks open filters; semantics and actual final results remain to be demonstrated.                                  |
| M9   | Agent: “Which properties in Lake County within five miles of [city xyz] have roofs older than 15 years?”            | Agent chat plus SQL/parcel/source citations                                                     | Use a real chosen Lake center and source-backed proxy explanation, not documentation-only retrieval.                                |
| M10  | Agent: long-open nearby roofing permits and listed contractor                                                       | Agent chat plus permit provenance                                                               | Show status/as-of/duration and source name; explain unavailable BBB and any unanswerable portion.                                   |
| M11  | MCP-ready interface/model usable by agents and CRM without changing the data model                                  | MCP initialize, tools/list and representative tool call; [MCP guide](packages/server/README.md) | Local tool checks exist; confirm the same chosen final dataset and coverage identity.                                               |

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
