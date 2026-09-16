# Local query repair — 2026-09-16

This is a query-only repair. It reuses the certified Clermont captures for
`lake-clermont-full-20260912t074749z`; it does not restart harvesting or change
capture evidence, approvals, signatures, or an existing publication.

## Preserve the capture boundary

- Capture checkout: `4de78dcc79f88445e0296c46231374fcd2eed947`, preserved in the
  operator's `approved-checkout-4de78dcc-v5` worktree.
- Certified baseline, hashed with the runtime's canonical JSON encoding:
  `05959a36584293386b52127513aa5b90728b3f634424b2141518ae8fb8e85e02`.
- Materialized CSV: 58,495 Clermont permits, all enumerated available records
  for 2015–2026, SHA-256
  `bbd2f8ba7361ffc4740b9f4aa20649cc56cddac31c49250f8bfecf41c3473c2a`.
- Metadata SHA-256:
  `2437ec58df667d7eb0dd0e1f6cd3c14f348a2a003a5a8b8283fb487e2b6e7152`.

Historical v5 certification, promotion and remote-sync operations remain bound
to the frozen checkout's prepared scopes. The materialization consumer instead
checks the exact requested baseline, source/configuration/schema signatures,
freshness, and artifact/output digests; it does not compare those signatures
with the active checkout's SQL or exact producer platform. The repaired query
code has separate provenance: do not rewrite v5 signatures to certify it.

## Repair and validation scope

The consolidation SQL selects latitude and longitude together from an actual
valid centroid source row. Roof-date anchors require explicitly closed permits
and valid nonfuture dates. Closed issued-date fallback remains a labelled proxy,
not proof of roof completion. `owner_count` is cast with ordinary `CAST` to
INTEGER so overflow fails instead of silently becoming null.

Full-table server counts distinguish total, assessed-roll-linked, and valid
unlinked permits. A property-only browser can report only its linked-permit
aggregate; it must not invent a county total or an unlinked count. Coverage
wording reflects the capture years in the supplied metadata, while retaining
municipal, historical, contractor, BBB, ownership and roof-proxy limitations.

The Clermont publication-evidence consumer now hashes the baseline with the
batch runtime's exact canonical JSON encoding, including its trailing newline.
This repairs a consumer mismatch; it does not change the certified baseline
digest or the general publication serializer. Runtime parity, exact approval
binding and content-tamper rejection are covered by regressions.

Use the existing direct SQL-to-DuckDB consolidation path from the runbook, with
outputs in a new versioned operator directory. Do not overwrite older published
tables. Keep source data, generated Parquet and operator evidence out of git.
Each local query build retains `query-provenance.json`, `verification.json`,
fresh `coverage.json`, and the parameter-expanded SQL beside its outputs.

The query provenance records the frozen capture commit/scopes/baseline separately
from the repaired HEAD and dirty-tree/file hashes. It also binds input/output
digests, SQL parameters, tool versions, timestamps and the exact invocation.
It is not the original v5-certified query schema and has no publication CID.

Readback gates are:

- 215,806 property rows and distinct folios, with no null keys.
- 76,166 permit rows: 72,187 linked and 3,979 valid unlinked; permit content
  unchanged from the certified-materialization load.
- 209,503 source-backed coordinate pairs; none combined from separate rows.
- All 63 property and 22 permit logical types match the shared contracts;
  `owner_count` is physical Parquet INT32 with unchanged values.
- Roof-date hierarchy, source-backed long-open roofing evidence, consistent
  coverage/UI/MCP count grains, and identical records on a repeated build.
- Focused SQL/count/coverage regressions plus real-data DuckDB/MCP checks.

## Verified local result

The separate query run is `lake-query-repair-20260916t105553z`. Its operator
directory is beside the capture stores, not inside the published run directory.
Independent readback passed every gate above. Differences from the original
load are restricted to 461 source-pair longitude corrections, two roof-date
corrections, and the owner-count physical type; owner values and all permit
records are unchanged. Repeated builds contain identical records, but the
property Parquet byte encoding differs, so each output has its own recorded
digest; byte-for-byte build determinism is not asserted.

Application regressions passed 411/411, pipeline regressions 663/663, and
vendored transform tests 4/4. An additional 91/91 API/MCP/DuckDB tests passed
against this new full local dataset. Workspace typechecks, changed-file lint,
formatting and diff checks passed. No model provider was called for the MCP
proof. This does not demonstrate current-run semantic RAG or hosted UI data.

The unchanged responsive-design matrix passed 100/100 after the 35 changed-view
checks passed. Playwright's pinned Chromium build 1243 was unavailable; Arceus
approved isolated headless sessions using already-installed Chrome
152.0.7977.84 with Playwright 1.63.0. Only the operator launch executable changed.
These are local mocked layout checks, including the honest legacy-count state,
not a hosted or new-data browser demonstration. The initial missing-browser
failure and the fallback configuration parity proof remain in the operator
evidence packet.

The older runbook and indexed corpus remain historical pre-repair snapshots.
Arceus routed this dated handoff into a separate, non-indexed note so the local
query repair does not silently rebuild or promote the old RAG corpus.

## Local consumer handoff

Oracle replayed the existing digest-bound consumption request once through the
current checkout's actual materialization CLI, using Node 22.23.1 and a new
isolated operator output root. It passed with the same 58,495 rows and exact CSV,
metadata and baseline digests listed above. No source was fetched again and the
already verified repaired Parquets were reused, not rebuilt.

The CSV exports selected contractor-of-record fields, not every contractor
contact retained in the captured details. Certified any-contact counters and
CSV contractor-of-record counters have different grains; the handoff records
both without presenting them as equivalent coverage or materialization loss.

Machamp independently reviewed the producer/consumer call chain and passed
11 focused existing fixture tests. This check demonstrated no need for a
consumer or CI rewrite. It is local evidence, not execution of the hosted
Ubuntu/GitHub workflow or a new certification of the repaired SQL.

The new `delivery-handoff-gGb1gD` operator packet links the original query packet
and binds this corrected note in a fresh working-tree snapshot. The original
packet passed its 61-file integrity check before this documentation correction.
Its evidence and historical snapshot are preserved unchanged, including their
earlier workflow warning; this note supersedes that warning, not the recorded
data or test results. Its old current-tree verifier is therefore no longer a
verifier for this updated note. Use the new handoff receipt for the current tree.

## Remaining boundaries

A successful local query repair is not county completeness or publication.
Contractor attribution remains Clermont-only; BBB and unavailable registry
fields stay null. Roof ages remain proxies, and the limited DOR sales window
cannot prove ten-year ownership tenure. No current-run RAG refresh is implied.

The existing GitHub workflow materializes against its current checkout through
`materializeClermontConsumption` and `materializeLastGoodClermontExport`. Neither
consumer invokes the active-repository prepared-scope guard. The earlier claim
that the SQL repair necessarily breaks this workflow was unsupported. Baseline
restoration must still supply the exact request, pointer and immutable artifacts;
current-checkout materialization does not certify the repaired query schema or
prove that the hosted Linux workflow has executed successfully.

S3 backup/readback, commits/push, deployment, IPFS publication, pruning and
RAG/registry expansion are outside this execution. S3 backup can be separately
approved for the immutable capture baseline; it does not certify the query layer.
