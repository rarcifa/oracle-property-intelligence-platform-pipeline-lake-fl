# September 17 submission handoff — finalized baseline, partial county coverage

This is the finite owner-approved delivery account, not county-completeness
certification or a passed full-assignment demo. The [README evidence matrix](../README.md)
addresses every clause while preserving the assignment brief verbatim.

## Evaluate the actual release

- [Existing designated PR #2](https://github.com/prismteam-ai/oracle-property-intelligence-platform-pipeline-lake-fl/pull/2).
  Consumer repairs and synchronized indexed documentation are pushed at
  `86044dad2241bd35f6bb13dc3b4b305045bbe690`; its actual CI completed successfully.
  Later evidence-only commits and the final review remain separately identified.
- [Hosted UI, REST, MCP and agent](https://tf2ynypdvfkv4dqxszpkj5emjq0imyxh.lambda-url.us-east-2.on.aws/).
  [Repaired live readback](../artifacts/hosted-runtime-readback-20260917.json) was observed
  at `2026-09-17T19:26:31.001Z`. App source is
  `86044dad2241bd35f6bb13dc3b4b305045bbe690`; the CDK code asset is
  `71b14abca7e76cdd3d9a90be825a792e29a5cd134a1371c32b967f3609467a43`.
  The [16:02 receipt](../artifacts/hosted-runtime-readback-20260917-before-score-repair.json)
  is preserved separately and is not proof of the repaired app.
- Finalized dataset baseline: `20260916T181000Z`,
  root `bafybeigakr7d6nywkbanzmh4r7cpv7kz7qs5vxvwlxcxuovk2lobrj442u`.
- [Complete baseline manifest](../artifacts/manifest-20260916T181000Z.json),
  [normal verification](../artifacts/verification-20260916T181000Z.json),
  [publication ledger](../artifacts/publication-attempts.json),
  [successful history](../artifacts/run-history.json) and [latest pointer](../artifacts/latest.json).
- [Published baseline RAG selector](../packages/rag/corpus-source.json) and
  [its promotion receipt](../packages/rag/promotion-receipt.json) now bind that finalized run/root.
- [Completed partial walkthrough](demo-walkthrough-20260917/walkthrough.webm)
  and [its immutable report](demo-walkthrough-20260917/preview-demo.json), recorded
  `2026-09-17T19:17:25.611Z`–`19:18:49.579Z` against the verified 7d4e26a deployment.
  `recordingCompleted:true`, `fullAssignmentDemoPassed:false`. All 25 original-prompt
  canonical rows and 50 historical rows independently replayed; the normal unsupported
  follow-up safely refused with HTTP 200. Both public manifest fetches matched.
  There were no console/API/external-gateway failures and no failures in 3,758 DOM
  checks or 105 pixel samples. Those samples are not exhaustive frame certification
  or proof that the underlying intermittent-blackout cause was repaired.
  Video bytes: 6,465,110; SHA-256:
  `c22296e08dba5708d8f378530857cc35c9e59bf35f4e1ed36fb565964ec71563`.
  Root independently matched the raw video size/digest and inspected the actual
  first-row and agent screenshots. Whole-video black detection found only the
  initial pre-ready loading interval, not a later all-background frame.

Publication, selected dataset, deployment and recording are separate identities.
The baseline is now published normally; that does not retroactively make the
earlier video's abstention, missing retention claim or full-demo failure pass.

## Retained records, not a restarted harvest

| Grain                                  | Finalized baseline | Pending incremental |
| -------------------------------------- | -----------------: | ------------------: |
| Distinct assessed properties           |            215,806 |             215,806 |
| Total permits                          |             76,166 |              76,431 |
| Lake CD Plus permits                   |             17,671 |              17,936 |
| Clermont permits, every 2015–2026 year |             58,495 |              58,495 |
| Linked permits                         |             72,187 |              72,450 |
| Valid unlinked permits retained        |              3,979 |               3,981 |
| DOR TPP business accounts              |             33,346 |              33,346 |
| Valid unmatched business accounts      |             31,286 |              31,286 |
| Joined property coordinate pairs       |            209,503 |             209,503 |

The twelve Clermont year partitions are retained. Raw historical permit types,
statuses, dates and source-listed names are available where captured. The
[retained-row receipt](../artifacts/clermont-historical-permit-evidence-20260917.json)
records 9,969 literal `ROOF/REROOF` observations, including 276 source `ISSUED`
rows, 266 with issued dates, and 135 issued before 2021-09-17. These are **not**
confirmed currently-open roofing permits and do not establish duration-open,
primary-roof completion, licensing, legal identity or BBB ratings. A bounded
normal-route detail probe timed out without semantic promotion or evasion.

Available owner/mailing fields and valid actual-built-year proxies are served.
Building-age proxy confidence is LOW, as of 2026-09-16; it is not measured roof
age. At fixed pin `28.5494,-81.7729`, five miles and integer minimum age 16
(strictly older than 15) return 23,696 proxies. Natural-language Clermont queries
use a labelled centre derived from the selected dataset's parcel coordinates;
that need not equal the fixed demonstration pin.

No-sale-in-the-2025–2026-DOR-window does not establish ten-year ownership tenure.
BBB null means unavailable enrichment, not zero or a bad score. Valid unmatched
businesses and properties without joined coordinates remain in the dataset.

## Baseline publication actually finalized

The normal attempt
`sha256:58bcde8efa72d848a5cedab4b8a6715516963c0034fdb16516b74dcebac5ec70`
is **`FINALIZED`** at `2026-09-17T17:33:43.074Z`, sequence 13. Its verification
is **41/41** objects: all 40 eligible manifest objects plus the manifest itself,
each matched in size/digest on unauthenticated public Filebase and Pinata gateways.

The ledger additionally records **completed Lighthouse retention** of the
manifest and full snapshot CAR/root DAGs: 1,352 verified blocks covering all
three manifest directory roots. This supplies an independent retained copy,
not just another HTTP locator. It is point-in-time retained availability,
not a guarantee that every copy may disappear while the bytes persist forever.

IPNS name
`k51qzi5uqu5dgd1ekyyuhwggov571fjxof2p5ef4ke7enlq60k03r47fosb2un`
was verified at **sequence 14**, resolving the baseline root. The name is a
mutable pointer; the CID is the immutable snapshot. Successful history and
latest now agree with the normal run.

The final step repaired local persistence after the original approval had been
consumed. It preserved execution commit
`4fc47a475bd01d483b81150b741914eec2f8bc32`, original target and existing
transitions; it performed no upload, new pin, new approval or IPNS write.
Earlier replication-only `REPLICATION_REQUESTS_RECORDED` receipts remain
historical and are not this normal attempt's current terminal state.

### Exact public artifact identities

| Baseline artifact     | CID                                                           | Logical bytes | SHA-256                                                            |
| --------------------- | ------------------------------------------------------------- | ------------: | ------------------------------------------------------------------ |
| Manifest              | `bafkreiezsu6lbe7v43vv5hq26tp2ucojuajvpntapw2rn6fhntuq3oyopm` |        11,417 | `99953cb093f5e6eb5e9e1af4dfaa09c9a01357b6607db516f8a76ce90dbb0e7b` |
| Complete snapshot CAR | `bafybeicasgbg4y75477jq73lm7rsiw4a6gcbz4yjxdy6dicv5aj2q5oriq` |   341,012,658 | `b09b1186e3111258300e0fef1ed5b721f99234e7b81df155454009b4bf4c659f` |

A vendor URL is a replaceable convenience locator:

```text
https://ipfs.filebase.io/ipfs/bafkreiezsu6lbe7v43vv5hq26tp2ucojuajvpntapw2rn6fhntuq3oyopm
https://gateway.pinata.cloud/ipfs/bafkreiezsu6lbe7v43vv5hq26tp2ucojuajvpntapw2rn6fhntuq3oyopm
https://ipfs.filebase.io/ipfs/bafybeicasgbg4y75477jq73lm7rsiw4a6gcbz4yjxdy6dicv5aj2q5oriq
https://gateway.pinata.cloud/ipfs/bafybeicasgbg4y75477jq73lm7rsiw4a6gcbz4yjxdy6dicv5aj2q5oriq
```

The logical CAR contains the dataset, sample and shard directory DAGs. Do not
substitute the differently serialized upload transport or a provider export.
Directory digests describe raw root blocks, not a gateway HTML directory listing;
the complete CAR makes independent import possible without re-encoding.

Optional third-party retrieval/import, using an explicit new download path:

```bash
curl --fail --location --max-time 300 \
  https://ipfs.filebase.io/ipfs/bafybeicasgbg4y75477jq73lm7rsiw4a6gcbz4yjxdy6dicv5aj2q5oriq \
  --output snapshot.car
wc -c snapshot.car
shasum -a 256 snapshot.car
ipfs dag import --pin-roots=true snapshot.car
ipfs cat /ipfs/bafybeigakr7d6nywkbanzmh4r7cpv7kz7qs5vxvwlxcxuovk2lobrj442u/query-table.parquet
```

These instructions do not assert that another candidate-operated node was run.
The committed manifest and public CID-addressed CAR require no candidate
credential to retrieve.

## Genuine later update: primary imports accepted, completion pending

[Integration evidence](../artifacts/incremental-integration-20260917T152549Z.json)
binds the original bounded CD Plus capture and actual records:
**265 inserts, 801 updates and 16,870 unchanged** county permit rows.
Replay is idempotent; all 58,495 Clermont rows, unrelated property rows and
business bytes remain unchanged. The later total is **76,431 permits**.
The capture time is `2026-09-16T18:05:22.523Z`; unchanged older records are not
given fresh timestamps. Zero removed projection rows do not prove no source
deletions outside the window.

| Pending incremental identity                   | Exact value                                                                 |
| ---------------------------------------------- | --------------------------------------------------------------------------- |
| Run / execution commit                         | `20260917T152549Z` / `ac4dd3ff037172f6e1753c53234532650954b98d`             |
| Root CID                                       | `bafybeicuvlx746twkowvsaz5g73ijajjirvxberemew747krlknfk5do7q`               |
| Manifest CID / bytes                           | `bafkreih5po2tge25ze6c5snnecdkumcoovkrrke7csh7haa63hjxtlyl4e` / 11,682      |
| Manifest SHA-256                               | `fd7bb533135dc93c2ec9ad2086aa304e755518a89f148ff3801ed9d379af0be1`          |
| Complete CAR CID / bytes                       | `bafybeie2isprhs53basx5g7ti3dufip5buw4qnihysshswhgsij4yyalpa` / 341,074,069 |
| CAR SHA-256 / valid blocks                     | `16d6eab31c798f6c4db0f73d7bd14cc6401051c7c172354819143ed2088ae914` / 1,353  |
| Normal durable state                           | `MANIFEST_UPLOAD_RECORDED`; primary imported CIDs accepted                  |
| Retention / latest / successful history / IPNS | Archive retention pending; not advanced for this run                        |

The [frozen candidate manifest](../artifacts/manifest-20260917T152549Z.held.json)
and 15:28 integration receipt preserve the original preparation state. Their
`held`/`published:false` fields are immutable statements at capture, not proof
that no later primary bytes became public.

The [18:06 standalone public observation](../artifacts/incremental-public-gateway-observation-20260917.json)
checked all 42 objects including the manifest but only **16** met two-host
size/digest requirements; the complete CAR and manifest succeeded. Pinata 429
and fallback fetch failures left 26 incomplete. This observation is not a
normal `VERIFIED` receipt, completed independent retention or finalization.

The [18:09 read-only provider dashboard receipt](../artifacts/lighthouse-incremental-queue-observation-20260917.json)
shows the exact archive migration request **queued**, not failed. Lighthouse's
notice says migration may require approximately 24 hours; it is not our ETA.
No billing cause is established and no duplicate migration, upgrade or payment
was made. This is a third-party retention queue, not missing local harvest data.

No new successful history/latest/IPNS sequence or second completed public
incremental demonstration is claimed. Those outcomes must follow actual
retention/all-object verification and normal publisher completion.

## Queries, preserved failures and remaining limitations

1. **Current-open/long-open roofing remains unmet.** Historical ROOF/REROOF,
   ISSUED and issued-date observations are queryable, but no accepted current
   status or duration basis exists. Source-only initial and clarified follow-up
   questions are refused before generation, not answered as zero leads.
2. **Ten-year ownership tenure remains unmet.** Available recent sales/ownership
   observations are insufficient; no challenge bypass or other candidate's data is used.
3. **Countywide completeness is not established.** Full assessed coverage does
   not prove complete jurisdictional/predecessor permit history. Conditional
   BBB/contact enrichment is unavailable; source limits are visible.
4. **Supported NL/runtime proof and completed partial recording exist.**
   The canonical aged-roof/radius route is deployed and independently replayed:
   strictly over 15 uses minimum 16,
   actual selected-data centre and query rows supply every ID/address/coordinate/proxy
   field. Arbitrary model aliases/prose are not accepted as canonical records.
   The completed exact-prompt take verified all 25 rows with no sampled paint failure;
   this is not a full-assignment demo pass or proof that all blackouts are eliminated.
   The later source-860 take failed a SQL-transition paint sample despite passing
   the same query/publication beats; the completed earlier take is not substituted
   for that later failure.
5. **Incremental public completion is pending**, although actual changed records,
   primary imports and partial public-byte proof exist. Baseline independent
   retention is now established and must not be described as still unproved.

The [failed sample lookup](../artifacts/agent-answer-failed-sample-check-20260917.json)
and [failed semantic take](../artifacts/failed-semantic-preview-20260917.json)
preserve an earlier model-prose ID/address absent from the selected dataset.
The earlier partial video safely abstained on the aged-roof list. Neither
correct citations nor a clean console proves a grounded answer. The repaired
recorder requires nonempty supported answers, independently replays each
bounded SQL evidence set against hosted MCP, and compares every displayed
canonical field. Source-only current-open refusal keeps
`fullAssignmentDemoPassed:false`; it is an honest limitation, not fulfillment.

## Cost, kit conformance and authority

Portable DuckDB/Parquet/MCP/CID access requires no always-on Oracle database.
Optional Lambda, model calls, secrets, logs and retention are owner-funded,
not free forever. Existing US$25 one-time/US$5 monthly-storage constraints remain,
with the separately approved existing Lighthouse Lite US$12/month exception.
No new provider/account/tier, harvest or pruning is introduced here.

The global official kit and retained Arceus route use Oracle +
`use-oracle`/`apply-engineering-guidelines`, Node 22, TypeScript/Zod/Vitest,
CDK and AI SDK. Prior authorship/reused threads are disclosed, not presented as
fresh independent consultation. Current Sunbiz then adequate dated DBPR-before-
permits conformance is not established for historical permit-first ingestion;
source-listed contractor names remain useful but not legal/license identities.

[Kit differences](../pipeline/docs/lake-kit-deviations.md) and
[observability handoff](observability-handoff.md) remain open evidence boundaries:
owner-approved SNS-only/PagerDuty-none and Arceus legacy-MJS routing do not
establish the required VP waivers; external Lexicon/Main Dashboard registration
is not proved. The runtime stack reports `AlertingConfigured:none`, not borrowed
harvest paging coverage. No full kit-compliance assertion is made.

Normal publication uses exact-target recorded human consent, not removed
per-commit personal signing. Legacy signatures/receipts are preserved; no
owner private key is read or used. Commits must be authored and committed only
as `rarcifa <ricardo.arcifa@cronoslabs.org>`, without co-authorship/session trailers.

## Verification boundary and final fields to fill

The CI-equivalent local unit run reports **677/677 passing, no skips**, with
the actual public selected snapshot and separately identified historical
regression fixture. All **125 responsive-browser tests** and **14 isolated
recorder checks** passed in the earlier run. The final recorder repair passes
**20/20**, retaining every black-detection test and adding first-row viewport
framing and actual failing-PNG preservation; 125 responsive checks also passed
again. These are diagnostic/framing improvements, not a verified blackout-cause fix.
Local lint, typecheck and build passed. A full actual DuckDB 1.5.5 CLI pipeline
run passed **1,135 tests plus four transforms**, without skips. The official CLI
download digest was verified; the local Homebrew 1.3.2 was not represented as 1.5.5.
Actual [CI for pushed head 96a3749](https://github.com/rarcifa/oracle-property-intelligence-platform-pipeline-lake-fl/actions/runs/35262312129)
passed all 670 app, 125 responsive and 14 recorder checks but failed two of 1,135
pipeline assertions because the clean runner lacked the ignored deployment bundle.
The bounded test-only correction stages an explicit synthetic asset with real CDK
while preserving stack-path, subscriber/IAM/alarm and incomplete-pin assertions;
it does not prove deployment bytes or change production code. New exact-head CI
is required after that repair, not a substitution of the local pass. Actual
[CI for pushed repair 7d4e26a](https://github.com/rarcifa/oracle-property-intelligence-platform-pipeline-lake-fl/actions/runs/35263762631)
is **completed/success**: build, selected public-byte download, both no-skip
query-suite guards, format, lint, types, all app/browser/pipeline/transform tests
and the county-readiness validator passed. Validator PASS confirms its catalog
and destination checks, not county-complete ingestion or a full-demo pass.
Actual
[CI for synchronized source 86044da](https://github.com/rarcifa/oracle-property-intelligence-platform-pipeline-lake-fl/actions/runs/35264570499)
also completed **success**, with every workflow step passing. Later evidence-only
commits still require their own exact-head CI.
The current
normal CLI index rebuild records **312 chunks / 141 documents / 50 source inputs**,
snapshot `sha256:19161f1faf2024e4064ed0941f8fa79bc7e0508cfcc3a0119b665c189c0a2f43`.
It recognizes retained acquisition separately from catalog certification and
visibly names both coverage and catalog authority. The unchanged benchmark still
has all 24 positives hit in the top three and all five negative controls abstain;
no ranking weights, thresholds or expected labels were edited.
Historical 554-app/1,094-pipeline/four-transform reports remain historical.
Local results are not substituted for the actual CI links above or a final new
Slowking score. The final review remains pending; completed and failed partial
recordings above are separate actual hosted evidence. Assignment speed is not inferred.

Before presenting the repaired delivery as final, add only actual evidence:

- **Commit/PR:** exact pushed full SHA, existing PR body and actual current-head CI
  run/check URLs and conclusions; no substitution of local QA for CI.
- **Runtime:** deployed app-source SHA/CDK asset digest, live health/meta/MCP
  readback, exact selected run/root/counts, and published documentation selector/index identity.
- **Recording:** actual replacement video/JSON paths and digests; exact original
  aged-roof prompt, every canonical row independently replayed, UI radius/proxy fields,
  real manifest/CAR/retention display and explicit unsupported-current-open refusal.
- **Incremental publication, only if completed:** normal manifest/verification,
  retained archive/root evidence, `FINALIZED` ledger, actual successful old/new
  history and IPNS name/resolved CID/sequence. Otherwise preserve the queued/16-of-42
  partial status and do not make the pending snapshot current.
- **Review:** new Slowking result tied to that pushed head, reachable runtime and
  actual replacement video; retained/fresh reviewer limitations disclosed.

These are final evidence links for existing authorized work, not a new harvest,
approval/signing loop or promise that unmet lifecycle/tenure/coverage can be
repaired by documentation alone.
