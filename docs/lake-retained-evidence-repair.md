# Retained-evidence repair — 2026-09-16

This is a separate, private conservative derivative, not another harvest or
capture certification. It preserves the earlier query repair and its receipts.
It does not update the hosted application, the indexed RAG corpus, the PR, or
any IPFS publication.

## Kit routing and scope

Arceus selected Oracle with `apply-engineering-guidelines`, `use-oracle`,
`county-readiness-preflight`, and the local preparation/export/validation
portion of `county-query-table-publish`, reusing the approved operator intake:

> No clean end-to-end kit match exists for retrospective, local-only derived-evidence repair. county-query-table-publish is the closest kit neighbour, limited to derivative preparation, export and local validation.

The owner approved the bounded local repair. The global official kit manifest
was version 0.46.26; the installed CLI entry reported `local`. No agents or
skills were copied into this repository.

The input code baseline is `999a0e42214ea36f6e7b2de7a816431a3d040258`.
Historical capture remains bound to
`4de78dcc79f88445e0296c46231374fcd2eed947` and canonical baseline digest
`05959a36584293386b52127513aa5b90728b3f634424b2141518ae8fb8e85e02`.
The new executed TypeScript/SQL/configuration have separate working-tree byte
bindings; the historical commit does not certify these uncommitted files.

## Conservative decision contract

All original 22 permit fields are preserved in `source_observations_json`.
Observation and decision columns must not be treated as interchangeable.

| Evidence available in retained exports                             | New accepted decision                                                      |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Clermont `FinaledDate` or CD Plus `Permit_CODate` observation      | No independently proven close, completion, or final-inspection date        |
| Exported permit status / roofing discovery flag / open duration    | No live current-status, primary-roof work, or duration-open conclusion     |
| License-like token in selected contractor contact text             | Literal text trace only; no dedicated printed-license or DBPR verification |
| Combined export license not supported by that literal contact text | Unverified directory candidate only                                        |
| Contractor display/contact name                                    | Source name only; no legal company/person resolution or proven absence     |
| Valid NAL actual built year                                        | Low-confidence building-age roof proxy, not measured roof age              |

Unsupported decision fields remain null and `needs_review`. Blank contacts
are not `confirmed_empty`; missing BBB data is not a zero score. Per-record
capture times are null because certification/export time is not observation
time. Each of 21 permit fields and both property built-year fields has exactly
one of the seven evidence states.

Dates require valid Gregorian, nonfuture values. Source-specific chronology
and completion semantics remain unaccepted rather than invented. Actual and
effective built years require an unpadded four-digit raw value between 1700 and
the explicit as-of year. Effective year is retained but is not substituted for
actual year in the building-age roof proxy.

Every eligible proxy includes the caveat that county, municipal and predecessor
permit history is partial, and an unobserved later replacement may exist.
No permit is currently accepted as a primary-roof replacement anchor.

## Full private result

The build and independent replay used as-of date 2026-09-16:

- 215,806 properties and distinct folios; 209,503 coordinate pairs preserved.
- 76,166 permits: 72,187 linked and 3,979 valid unlinked.
- 58,495 Clermont permits across all twelve 2015–2026 partitions.
- 17,671 unique CD Plus permits from the retained rolling last-modified window,
  2025-09-09 through 2026-09-08; this is not complete unincorporated history.
- 169,007 valid actual built-year proxies; 120,362 have a building-age proxy of
  **at least** 15 years. Neither count measures or confirms actual roof age.
- Actual built year: 169,007 `confirmed_present`, 46,799 `unknown`.
  Effective built year: 169,006 `confirmed_present`, 46,800 `unknown`.
  The other five states have zero observations in these acquired field partitions.
- 4,009 literal contact-text license traces; 32,408 unverified directory
  candidates. No accepted printed license, official license or company identity.
- 111 quarantined field observations: 107 malformed license-token observations
  and four date observations, not necessarily 111 distinct permits.
  The trace-origin label `conflicting` for those 107 tokens is not evidence of
  a source conflict: their field state is `invalid_quarantined`, and the
  permit field partitions contain zero `conflicting` observations.
- 21,971 trace-origin `absent` entries mean no usable license token in the
  retained contact/export text, not a contractor or printed-license absence.
  The 17,671 CD Plus trace origins remain `unknown`.

Both new Parquets have identical records on replay; all eight data/readback/
quarantine outputs also have identical bytes. SQL contains different private
output paths and is separately bound. All 52 unaffected property columns,
permit identifiers and linkage remain unchanged. Oracle independently verified
every original permit observation, all property IDs and coordinate pairs, all
seven-state totals, and all thirteen source-period partitions.

The final integrity audit rehashed 41 historical source files, checked their
committed bytes, rehashed 13 input/export/historical-receipt bindings, four
capture-envelope bindings, eleven prior packet files, both sets of ten new
outputs, and the four executed source/configuration bindings for each build.
It reused historical full-capture verification; it did not claim a new rehash
or certification of the complete roughly 12 GB capture archive.

## Reproduce locally

Use Node 22 and the existing DuckDB CLI. Both inputs are prior immutable
operator JSON packets; output must be a new private directory outside the
repository, input directories and earlier packets, including symlink aliases.

```bash
node pipeline/node_modules/tsx/dist/cli.mjs \
  pipeline/scripts/lake/build-retained-evidence-derivative.ts \
  --input-freeze /absolute/private/candidate-input-freeze.json \
  --readiness-report /absolute/private/oracle-readiness.json \
  --output /absolute/private/new-evidence-candidate \
  --as-of-date 2026-09-16 \
  --duckdb /opt/homebrew/bin/duckdb

node pipeline/node_modules/typescript/bin/tsc \
  -p pipeline/tsconfig.evidence.json --noEmit
```

The driver makes no network requests, does not inherit service credentials into
DuckDB, refuses existing output, validates frozen hashes before writing and
rehashes inputs afterwards. It writes `DO_NOT_PUBLISH.json`, source-preserving
JSONL, quarantines, separately named Parquets, readbacks and `handoff.json`.
Keep raw data, derivatives and operator receipts out of git. A final outer
audit also rechecks historical source bindings after execution.

Validation passed 742/742 pipeline tests, including 73 pure evidence-contract
and six DuckDB integration tests; 411/411 application tests; and 4/4 vendored
transform tests. Strict derivative typecheck, explicit changed-file ESLint and
Prettier, and diff checks passed. The initial broad regression attempt failed
when subprocesses inherited Node 25 and esbuild was missing from their PATH.
Re-running with the existing Node 22 and esbuild binaries on the local test PATH
passed without installing dependencies or changing tracked runtime code.

Both official and retained county catalog validators, plus the official
readiness self-test, passed. That catalog-preparation result is not release
readiness or permission for new acquisition.

## Remaining release boundary

`releaseReady: false`, `countyComplete: false`, and
`publicationApproved: false` remain mandatory. Other thirteen permit
jurisdictions retain their recorded limitations and null acquisition/
seven-state counts; this repair did not re-probe them.

Next work needs accepted source-profile status/work/date semantics, independent
completion evidence and record capture-time/freshness proof. Official Sunbiz
and adequate temporal DBPR acquisition remain required, separately scoped
dependencies, not permanent accepted gaps. BBB remains policy/API-gated.
Publication also needs privacy/retention approval and complete CID-addressed
two-independent-gateway proofs. No RAG/demo/publish/deploy or Git/PR write was
performed by this repair.
