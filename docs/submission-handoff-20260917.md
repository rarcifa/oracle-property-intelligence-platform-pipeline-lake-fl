# September 17 submission handoff — source-only partial preview

This is the finite owner-approved handoff, not a certification of county completeness.
The assignment README remains the brief and its acceptance matrix records every clause.
No new harvest, provider, paid upgrade or signature round is introduced here.

## Evaluate this delivery

- Existing designated [PR #2](https://github.com/prismteam-ai/oracle-property-intelligence-platform-pipeline-lake-fl/pull/2).
- Public [hosted UI, REST, MCP and agent](https://tf2ynypdvfkv4dqxszpkj5emjq0imyxh.lambda-url.us-east-2.on.aws/). No evaluator credentials or local installation required.
- Selected run: `20260916T181000Z`; immutable root `bafybeigakr7d6nywkbanzmh4r7cpv7kz7qs5vxvwlxcxuovk2lobrj442u`.
- Complete [40-object manifest](../artifacts/manifest-20260916T181000Z.json); manifest CID `bafkreiezsu6lbe7v43vv5hq26tp2ucojuajvpntapw2rn6fhntuq3oyopm`.
- Final partial walkthrough: [video](demo-preview-final-20260917/walkthrough.webm) and [machine-readable recording report](demo-preview-final-20260917/preview-demo.json).
- [Final hosted-runtime readback](../artifacts/hosted-runtime-readback-20260917.json) binds the deployed application source, CDK asset, run/root, MCP counts and explicit unsupported-filter refusal.
- [Every-object two-gateway inventory](../artifacts/submission-gateway-inventory-20260917.json), assembled from immutable live observation receipts. It is not a new publisher transition.

The explicitly pinned runtime does not move IPNS or claim `FINALIZED`. Its run,
root and coverage are bound to the same actual bytes. Historical successful
publication history stays historical. The RAG structured selector remains the
older local candidate; rebuilt prose is documentation evidence, not current parcel data.

## Loaded and served records

| Grain                             | Selected hosted snapshot | Later held local candidate |
| --------------------------------- | -----------------------: | -------------------------: |
| Distinct assessed properties      |                  215,806 |                    215,806 |
| Total permits                     |                   76,166 |                     76,431 |
| Lake CD Plus permits              |                   17,671 |                     17,936 |
| Clermont 2015–2026 permits        |                   58,495 |                     58,495 |
| Linked permits                    |                   72,187 |                     72,450 |
| Valid unlinked permits, retained  |                    3,979 |                      3,981 |
| DOR TPP business accounts         |                   33,346 |                     33,346 |
| Valid unmatched business accounts |                   31,286 |                     31,286 |
| Joined coordinate pairs           |                  209,503 |                    209,503 |

Owner names/mailing fields and valid actual-built-year proxies are available.
Roof age is a low-confidence building-age proxy as of September 16, not measured
roof age. At center `28.5494,-81.7729`, the five-mile strictly-over-15 query uses
integer threshold 16 and returns 23,696 properties. No-sale-in-the-2025–2026-DOR-window
does **not** prove ten-year ownership tenure. BBB is unavailable/null, not a bad score.
Source-listed contractor names are Clermont-only, not verified legal identities.

## Immutable public artifact and CAR retrieval

CIDs are identities. These public HTTP URLs are interchangeable convenience locators:

```text
https://ipfs.filebase.io/ipfs/bafkreiezsu6lbe7v43vv5hq26tp2ucojuajvpntapw2rn6fhntuq3oyopm
https://gateway.pinata.cloud/ipfs/bafkreiezsu6lbe7v43vv5hq26tp2ucojuajvpntapw2rn6fhntuq3oyopm
https://ipfs.filebase.io/ipfs/bafybeicasgbg4y75477jq73lm7rsiw4a6gcbz4yjxdy6dicv5aj2q5oriq
https://gateway.pinata.cloud/ipfs/bafybeicasgbg4y75477jq73lm7rsiw4a6gcbz4yjxdy6dicv5aj2q5oriq
```

The logical `snapshot.car` is exactly **341,012,658 bytes**, SHA-256
`b09b1186e3111258300e0fef1ed5b721f99234e7b81df155454009b4bf4c659f`.
It includes the dataset root and sample/shard directory DAGs; their mappings are
in the manifest. Do not substitute the differently serialized root-only upload
transport or a provider export when checking this logical artifact's digest.
Directory inventory digests cover raw root blocks, not a gateway HTML listing;
the CAR supplies the complete DAGs for independent import without re-encoding.

```bash
curl --fail --location --max-time 300 \
  https://ipfs.filebase.io/ipfs/bafybeicasgbg4y75477jq73lm7rsiw4a6gcbz4yjxdy6dicv5aj2q5oriq \
  --output snapshot.car
wc -c snapshot.car
shasum -a 256 snapshot.car
ipfs dag import --pin-roots=true snapshot.car
ipfs cat /ipfs/bafybeigakr7d6nywkbanzmh4r7cpv7kz7qs5vxvwlxcxuovk2lobrj442u/query-table.parquet
```

Use an explicit new download path; importing is an optional third-party action,
not an assertion that this pipeline ran another node. The manifest can be fetched
and digest-checked without any candidate credential. All 40 listed objects and
the manifest itself have recorded two-host matching size/digest proof; the final
archive check completed at `2026-09-17T15:17:03.606Z`.

## Actual later update, not metadata-only CID churn

[Integration proof](../artifacts/incremental-integration-20260917T152549Z.json)
binds the previously captured bounded CD Plus window to the original source bytes.
The separate builder replays all 265 inserts and 801 updates, verifies idempotence,
preserves all 58,495 Clermont records and all business bytes, and compares actual
Parquet records. The later local root is
`bafybeicuvlx746twkowvsaz5g73ijajjirvxberemew747krlknfk5do7q`.
Its [held manifest](../artifacts/manifest-20260917T152549Z.held.json) is reproducible,
and its multi-root CAR has 1,353 verified blocks. It is **unpublished**: no later
public CID retrieval, successful history entry, IPNS repoint or RAG promotion is claimed.

The window's genuine observation time is `2026-09-16T18:05:22.523Z`; it does not
give fresh timestamps to unchanged older records. Zero removals in the retained
projection do not prove zero source deletions outside that window.

## Explicit unmet results and constraints

1. **Single-vendor-independent availability remains unproved.** Filebase imports
   are fully verified and Lighthouse registration/metadata reconciles, but no
   CID-specific completed independent IPFS-retention acknowledgement was established.
   Public gateway retrieval alone does not prove another provider holds the DAG.
   Empty Filecoin deal lists are recorded observations, not an extra Filecoin gate
   or proof that Lighthouse has no copy. See [the bounded check](../artifacts/lighthouse-retention-check-20260917T151751Z.json).
2. **Later incremental public publication remains held**, despite real integration
   and changed local CIDs. Latest/row hashes/successful history/IPNS were not promoted.
3. **Current-open roofing permits and duration are unknown**, not zero. Historical
   status/date/work text is retained, but undated captures and unaccepted semantics
   do not establish current status, primary-roof completion or defensible long-open leads.
4. **Ten-year ownership tenure is unmet** because adequate historical sales/ownership
   evidence was not acquired. Managed-challenge 403 and available-source limitations
   are documented; no challenge evasion or another candidate's data is used.
5. **Countywide completeness is not established.** NAL is fully loaded, but permit
   history is jurisdiction/source constrained. BBB and additional contact enrichment
   are conditional and unavailable. Official identity baseline ordering/adequate
   Sunbiz/DBPR temporal relationships remain a separate kit-conformance limitation.
6. **Natural-language property lists are not reliably established.** The model
   can fail to return usable canonical parcel rows; the guard then abstains rather
   than inventing samples. The recorder labels that question unfulfilled. Every
   displayed sample, when present, must pass an independent hosted query replay.

A clean console is not proof of grounded model output. The earlier September 17
take produced a sample identifier/address absent from the selected dataset; the
[negative lookup](../artifacts/agent-answer-failed-sample-check-20260917.json) and
[failed semantic report](../artifacts/failed-semantic-preview-20260917.json) remain
separate failed evidence. The corrected agent renders query-derived sample fields
server-side and refuses unsupported open/long-open decisions before generation.
The final recorder independently replays each sample's hosted query and compares
every displayed canonical row rather than trusting citation presence alone.

The replication ledger's actual terminal scope is `REPLICATION_REQUESTS_RECORDED`,
revision 22, not `FINALIZED`. Its [sanitized receipt](../artifacts/replication-reconciliation-20260917T134256Z.json)
preserves the original immutable target and sequence-13 predecessor. No active
harvest is needed for this handoff; the twelve retained year partitions are complete.
No pruning, new provider requests or additional paid subscriptions were run here.

## Cost, authority and authorship

Deployment uses the already-approved account `122610508924`, `us-east-2`, `etl`.
The US$25 cumulative one-time and US$5/month storage ceilings are unchanged, with
the separately owner-approved existing Lighthouse Lite US$12/month exception.
No new vendor/account/tier is created. Optional Lambda, model calls, Secrets Manager,
logs and retention are owner-funded; portable DuckDB/MCP/CID access has no required
Oracle-hosted database or always-on compute. No free-forever retention is promised.
The SNS-only/PagerDuty-none deviation stays disclosed; the runtime stack reports
`AlertingConfigured: none` rather than borrowing the baseline harvest SNS coverage.

Normal publication/replication use exact-target recorded human consent, not the
removed per-commit personal-signing requirement. Existing recovery signatures and
legacy receipts are preserved; no owner private key is read or used by the assistant.
Commits are authored and committed only as `rarcifa <ricardo.arcifa@cronoslabs.org>`,
with no co-authorship or AI/session trailers.

## Verification and evaluation boundary

The ingestion suite passed **1,094 tests across 86 files plus four transform tests**;
the application suite passed **554 tests across 58 files**, seven typecheck tasks,
four build tasks, repository/county lint and formatting checks on September 17.
The final deployment identity, recording
digest and review head are recorded with the final submission artifacts.
The final recorder rejects app console/page errors, blank roots, missing actual age
filters, empty model answers, wrong run/root coverage and mismatched public manifest bytes.
The gateway pages' favicon-only 404/401 warnings are retained separately in the report;
all other gateway console errors still fail the recording.
It still reports `fullAssignmentDemoPassed: false`.

Slowking must judge the actual pushed PR head and reachable runtime/video, not
unpushed working files. Assignment-sent datetime is not established, so speed
must not be guessed. The old 72/100 intake is historical, not this delivery's score.
