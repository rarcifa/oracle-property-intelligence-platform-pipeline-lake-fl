# Repository quality audit

Audit date: 2026-09-11
Decision: **save and repair; do not restart from scratch**

## Method

Arceus routed the repository through the official Soofi kit's candidate-evaluation and
Oracle workflows. The audit read the assignment README and its Roofing CRM, Soofi Team
Kit, and Elephant Oracle Skills references, then inspected the local implementation,
public runtime and IPFS evidence, source catalog, clean-runner behavior, publication
authority, RAG provenance, CI, infrastructure, and responsive application.

The starting verdict was **Partial Pass, 72/100**. The architecture and existing public
data product were substantial enough to save. The right repair was to close the evidence
and safety gaps, not discard working ingestion, DuckDB, REST, MCP, UI, and publication
code.

## Material findings at intake and re-audit

1. Permit data was exposed only as parcel aggregates; no queryable permit-grain table/API
   preserved permit number, status, date sequence, duration, linkage, and contractor
   evidence.
2. The deployed/public snapshot predated the bounded Clermont contractor harvest.
3. A reusable `approved: true` JSON gate could authorize future watermarks, and the
   scheduled workflow ignored its `publish` input whenever Filebase credentials existed.
4. A disposable runner manufactured an empty Clermont export. Contractor loss was also
   absent from the publication shrink gate.
5. The completed Clermont capture covered permit year 26 only. The portal's known
   searchable history spans years 15–26, so 4,061/4,061 meant complete for that bounded
   job, not complete for the available source.
6. The RAG index mixed an older public run's CIDs and manifest with newer local bytes.
7. A future-issued permit produced a negative open duration, and the generic and roofing
   duration controls had drifted across UI, REST, MCP, SQL, and agent interpretation.
8. The production chat endpoint still used Anthropic/Claude despite the repository's
   migration to Codex/OpenAI.
9. CI was missing, runtime logs retained only 30 days, and CDK tests staged gigabytes of
   mutable local data and dependencies into the system temporary volume.
10. The README overstated the bounded Clermont harvest and did not maintain a strict
    public-versus-local release boundary.

## Repairs completed locally

- Removed the duplicated `.claude` kit tree after extracting the Lake-specific runtime to
  `pipeline/`. Repository instructions now live in `AGENTS.md`; Soofi agents and skills
  come from the globally installed Codex plugin (`0.46.1`, installed and enabled).
- Added a typed 22-column `permit-table.parquet` retaining all 21,732 source permits,
  including 511 valid records that do not join the current assessed roll. REST, MCP,
  property drilldown, SQL, and UI consumers expose the permit rows.
- Added explicit `minOpenRoofingPermitDays` semantics through shared validation, SQL,
  UI URL state, REST, MCP, RAG interpretation, and contractor leads. Generic permit
  duration remains separately named. Future-issued dates clamp to zero.
- Replaced the boolean publish switch with a one-use Ed25519 authorization over county,
  run, root CID, manifest/provenance digests, bucket, existing IPNS name/key, ordered
  actions, expiry, nonce, and approver. Attempts are append-only and resumable; approval
  is consumed after verified IPNS readback.
- Added an independent non-Filebase pinning stage for both the root and manifest before
  gateway verification. Added predecessor fencing so a stale or unknown live IPNS value
  cannot be overwritten.
- Made publication accounting recover property row hashes from the immutable predecessor
  Parquet on clean runners. A missing or unreachable recorded predecessor fails closed.
- Rebuilt the workflow as two phases: build/upload a frozen local candidate, then restore
  that exact artifact by workflow-run ID for a separate manual publish dispatch. Scheduled
  runs never publish, and credentials alone never grant authority.
- Removed cache and empty-export fallbacks. Clean runners can consume only an exact,
  digest-bound Clermont last-good bundle through a read-only OIDC/S3 path. Contractor
  counts now participate in shrink gates.
- Added typed Clermont contracts, partition planning for exact years 2015–2026,
  conservative cost/time approval, leases and fencing, heartbeats, bounded backoff,
  circuit breaking, immutable handoffs, content-addressed baselines, CAS last-good
  pointers, and atomic verified materialization. No full historical live harvest was run.
- Bound the deterministic local RAG index to one explicit `20260911T131000Z`
  `local_candidate` receipt. It hashes every run artifact and generator input, carries no
  borrowed public CID, and refuses to answer when its identity differs from the dataset
  being served.
- Migrated the application model provider to `@ai-sdk/openai`, `OPENAI_API_KEY`, and an
  OpenAI Secrets Manager contract. No provider key is placed in Lambda configuration.
- Added PR/push CI with format, lint, typecheck, tests, builds, browser breakpoints,
  readiness, a real downloaded Parquet, and a guard that query-layer tests do not skip.
- Increased runtime log retention to 90 days and retained structured logs, active X-Ray,
  business metrics, self-resolving alarms, bounded concurrency, and optional production
  PagerDuty/SNS wiring. The synchronous read-only HTTP runtime has no queue, so a DLQ is
  explicitly not applicable.
- Excluded mutable data, tests, fixtures, and dependencies from the Batch Docker/CDK asset
  context, reducing synthesis from multi-gigabyte temporary copies to the files named by
  the Dockerfile.

## Repaired local data gates

| Gate                                           |                     Result |
| ---------------------------------------------- | -------------------------: |
| Property rows / distinct parcel ids / null ids |      215,806 / 215,806 / 0 |
| Permit rows / distinct permit ids / null ids   |        21,732 / 21,732 / 0 |
| Linked / valid-unlinked permits                |               21,221 / 511 |
| Clermont year-26 achievable / loaded / dead    |         4,061 / 4,061 / 71 |
| Clermont known years loaded / available        |                     1 / 12 |
| Coordinates                                    |                    209,503 |
| Permit rows with contractor of record          |                      3,634 |
| Distinct contractor names / licenses           |                  996 / 823 |
| BBB ratings                                    | 0, explicitly source-gated |

The repaired local run is `20260911T131000Z`. Its dry-run root CID is
`bafybeih5xrlpzdvjoky75aq7j2cad36dnnzec4suqiwboy3ucayjgyeqnq`, and its manifest
CID is `bafkreiaqiwvmkfgz7yziuxeurgb4jpecbzwh57rj3qbzyjszsv2ltuhmwy`. Revisioned
handoff evidence is in
`artifacts/orchestration/lake/20260911T131000Z-r002-prepared-local.json`.

## Final local validation

The repaired tree passed the following gates on 2026-09-11:

- Application unit suite: 36 files and 384 tests passed.
- Responsive browser suite: 100 checks passed across 320, 390, 820, 1280, and
  1440 pixel widths.
- Extracted county pipeline: 60 files and 524 tests passed, followed by all 4
  vendored transform tests.
- RAG contract, promotion, retrieval, and reproducibility tests passed against the
  explicit local candidate receipt.
- Root format, lint, typecheck, production build, and `git diff --check` passed.
- Root and pipeline dependency audits report zero known vulnerabilities after upgrading
  Vitest, Vite, MapLibre GL, esbuild, and adm-zip to patched releases.
- Lake source-catalog readiness passed all catalog, parcel, permit, destination,
  and enrichment gates.
- The hosted runtime Lambda bundle assembled at 120,051,259 bytes with the Linux
  ARM64 DuckDB binding and bundled `httpfs` extension.
- The hosted runtime, Batch, and private versioned Clermont baseline CDK stacks
  synthesized successfully. Batch synthesis used a validation-only `.invalid` alert
  address; a real operator address remains required at deployment time.

No test used publication credentials or changed AWS, Filebase, an independent pinning
provider, IPNS, PagerDuty, or the linked public runtime.

## External completion boundary

The fork's unsafe legacy scheduled workflow was disabled as a reversible containment
measure; it remains disabled until the repaired workflow is on the default branch and its
digest-bound baseline inputs are configured. The local candidate has not been uploaded,
independently pinned, publicly verified, or pointed to by IPNS. No AWS Batch job,
workflow dispatch, deployment, or PagerDuty incident was created. The repaired branch has
not been promoted to the fork's default branch or submitted to the designated upstream.

Two hard data/release blockers remain:

1. Permit years 15–25 are known accessible from Clermont but have not been harvested or
   certified. The implemented coordinator estimates and gates that work, but the sustained
   capture and durable baseline location require an operator-approved external run.
2. Public release requires an independent pinning provider plus a fresh short-lived
   Ed25519 authorization for the exact frozen request. Hosted runtime deployment and RAG
   promotion are later, separately approved actions.

Until those actions occur, the linked public runtime truthfully serves run
`20260910T225242Z`, while `20260911T131000Z` is local validation evidence only.
