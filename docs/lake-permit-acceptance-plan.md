# Lake permit evidence acceptance plan

This is the approved **local planning stage**, not a new harvest, accepted source
profile, production repair or submission sign-off. All machine specifications are
`draft_unaccepted`; source-profile acceptance, decision promotion, production
eligibility, release readiness and county completeness remain false.

Arceus routed this stage to Oracle only, using `apply-engineering-guidelines`,
`onboard-county` and `use-oracle`'s offline permit-evidence preflight as the closest
kit neighbour. The answered intake and approval cover this planning scope; the
kit's live ingestion, destination, publication and Git procedures are excluded.

## Preserve the verified baseline

Keep the existing 13 untracked repair/extractor files, tracked production code,
retained captures, earlier derivatives and private handoffs unchanged. HEAD remains
`999a0e42214ea36f6e7b2de7a816431a3d040258`.

The sealed extractor packet is the count authority for this plan, not older
catalog comments that describe Clermont's initial 2026-only pilot. The unchanged
sample contains 48 Clermont records: four per year, 2015–2026. It preserves 159
contact rows, 276 inspection rows, 176 scheduled-date values and 172
inspection-event completed-date values. Its 20 fields retain all seven evidence
states, with one state per record and 48 records conserved per field.

`confirmed_present` in this unaccepted observation snapshot does not make a
status, work class, completion date or identity decision accepted. All 48 original
per-record capture timestamps remain null/`unknown`; this is not zero current
records or proof that the source cannot expose timestamps. The sample observed no
explicit empty markers, which does not prove contractor absence.

Lake CD Plus's 17,671 existing permit rows are outside this review: reviewed counts
and field-state counts remain null. Its known modification window is not complete
historical coverage. Thirteen other municipal coverage gaps retain unknown/null
record and evidence counts. The Clermont sample cannot accept county completeness.
Existing valid built-year estimates remain unchanged low-confidence proxies, not
definitive roof ages or proof that no later replacement occurred.

## Evidence needed before decisions

| Decision                         | Required evidence                                                                                                          | Held until proved                                                    |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Current/open or completed permit | Official status dictionary, source authority and accepted precedence; independent index/live evidence and genuine receipts | Mapping, current freshness and long-open conclusions                 |
| Close/completion or roof date    | Source-specific lifecycle meaning, calendar validity, justified chronology and accepted completed work                     | `Finaled` as an anchor; inspection events as permit/roof completion  |
| Primary roof work                | Explicit detailed source scope and fixture-tested replacement/new-construction versus repair/coating/accessory rules       | Positive work class from a flat type, trade or regex alone           |
| Unassigned contractor            | Successful official lookup against a proved capable section, with accepted absence semantics                               | Empty marker, blank listing field or missing grid as confirmed-empty |
| Legal contractor/company         | Official Sunbiz followed by adequate dated DBPR relationships, exact identity and attribution-date proof                   | Contact-name tokens, directory candidates and reputation matches     |

Obtain official dictionaries, source-role evidence and historical migration
boundaries for each relevant source/period. Preserve every raw label and literal
date beside separate normalization. An accepted source `Finaled` semantic may
eventually provide **one** valid close/completion anchor; three aliased lifecycle
dates are not independent evidence or a permanent requirement. Completed status
and explicit primary-roof work still need their own proof.

Inspection `Scheduled Date` and inspection-event `Completed` remain inspection
events. Future scheduled or expiration dates can be valid calendars, while a
future calendar-valid `Finaled` value cannot become a present completed-work anchor
without the source's chronology/as-of gates. Never invent dates or substitute an
application date, permit-number year or neighboring record.

Original index and detail observation times are unknown. A future timed detail
response alone does not prove the old index is older or stale. An independently
accepted source-authority rule could later select verified live current status
without inventing an index timestamp. Unresolved disagreement stays
`conflicting`/`needs_review`.

## Prospective capture receipts and freshness

Specify receipts now; create none in this stage. Future actual capture must bind
the explicit source identity, official route, raw-byte SHA-256/size, genuine
same-record UTC observation clock, profile/fingerprint revision, reviewed
adapter/worker/runtime provenance and authorization reference. Retain the receipt
digest in an immutable external manifest rather than a circular self-hash.

Retain index, live detail, contacts and inspections independently. Offline replay
retains the original clock; export, certification, partition, directory and file
times are processing/storage metadata, never replacement observation timestamps.
A future receipt binds only the new response and does not repair the original
null timestamps.

Decision as-of, inference window, maximum evidence age and refresh cadence are
**pending owner decisions**, with no accepted default. A valid calendar alone does
not establish chronology, freshness or completion.

## Official identity must precede future permit capture

The retained historical capture occurred before an adequate loaded/reconciled
Sunbiz-plus-DBPR baseline. Preserve that retrospective kit-sequence deviation
honestly; nothing in this plan retroactively makes registries first.

For future acquisition, assess or acquire/load/reconcile Sunbiz first, then apply
DBPR's mandatory adequacy-or-acquire gate. Adequate DBPR means official, loaded,
reconciled, dated licenses, qualifier/person evidence, qualified-business
relationships, status and effective dates covering the chosen permit attribution
window. A current snapshot alone cannot prove a historical business relationship.
Missing DBPR is not optional enrichment or permission to capture permits first:
acquire official records after approval, or wait for explicit owner abort.

Reuse the catalog's prior 403/API/custodian limitations without re-probing. Before
future filing, verify the official Sunbiz/DBPR recipient and authorized ingest or
records-request route. Only catalogued first-party hosts are retained here; no new
staff names, contact URLs, fee/legal assertions or outbound requests are invented.
Clermont's known eTRAKiT search portal does not provide a verified dictionary
request recipient; that route remains pending. Lake County Office of Building
Services and its catalogued public-records portal are a separate CD Plus route,
not a substitute for the municipal ledger. See the existing
[source catalog](../pipeline/docs/lake-sources.yaml).

The future resolver emits exactly one ladder outcome per evaluated contact:
`verified_license`, `verified_company_via_license_relationship`,
`accepted_company_qualifier_candidate`, `unresolved`, `ambiguous` or `conflicting`.
Require exact official identities, unique candidates and effective periods for the
accepted attribution date. Name-only/hyphen-folded collisions remain unresolved
or ambiguous; no phone, email or private contact field participates in matching.
BBB is reputation, not license or corporate identity evidence.

Verify deployed schema and immutable resolver-ledger retention before any future
write. The only supported company edges are `permit_contacts.company_id` and
`property_improvements.contractor_company_id`, targeting `companies.company_id`.
The permit-level edge requires all relevant contractor contacts to agree. No
generic SID, invented license FK, BBB child ID as DBPR identity, or name-only
person edge is allowed. Preserve raw licenses and omissions. Missing license
schema and inadequate registry snapshots are distinct gaps; schema limitations do
not waive DBPR acquisition. Identical accepted inputs/version must be a no-op;
changed inputs preserve superseded resolution and reconciliation evidence.

## Next execution proposal — not started

1. Owner chooses as-of/inference/freshness/access scope and reviews these drafts.
2. Separately authorize official route/custodian verification and dictionary work.
3. Complete Sunbiz adequacy-or-acquire, load and reconciliation first.
4. Complete adequate dated DBPR acquisition/load/reconciliation second.
5. Separately approve receipt instrumentation and prove engineering/readiness
   gates, exact runtime/US egress, direct execution state and remaining budget/cap.
6. Only then recapture decision-critical members of the **same frozen set**, at
   most 48 records, narrowed after policy choices. No full restart or new keys.
7. Review actual per-source/period evidence for field-level acceptance. Keep
   unresolved conclusions ineligible; integration and release are later scopes.

One future exact-scope GO may cover that ordered graph, with automatic advancement
through already-authorized dependency-ready stages. The numbered stages do not
require seven approval cycles. Pause only for a genuine uncovered authority,
scope, access, privacy/fee or feasibility decision, or an unresolved fail-closed
gate. No additional approval is needed inside this current planning scope.

For a future separately approved run, concurrency 2, 600 ms minimum delay,
maxAttempts 3, four-hour partition timeout, no pruning/IPFS and SNS-only remain
proposed upper constraints, subject to stricter source policy. The prior US$25
one-time, 72-hour and US$5/month storage ceilings are not new spending authority
or proof of remaining budget/time. Direct baseline and owner GO are required.
A newly proposed source whose full-download estimate exceeds 48 hours requires
the operator's download/ingest-only/owning-app-runtime decision, not a silent
scope expansion.

## Local handoff

The private plan packet contains `draft-permit-semantics.json`,
`draft-freshness-and-receipt.json`, `draft-identity-prerequisites.json`,
`gap-ledger.json` and `proposed-execution-scope.json`. It binds the sealed prior
reports and preserves each gap's owner, exact fix and ineligible downstream effect.
All specifications are drafts, not loaded schema, accepted profiles, created
receipts, resolver executions or queued durable jobs.

Verification for this documentation-only stage is actual JSON contract/count,
dependency/null/flag consistency, Prettier and immutable-input checking. No new
runtime tests or pipeline execution are claimed. Future implementations must use
strict TypeScript, Vitest, actual tsc/ESLint/Prettier and the kit's existing stage
skills; cloud IaC remains CDK-only and LLM work uses Vercel AI SDK.

`LOCAL_PERMIT_ACCEPTANCE_PLAN_COMPLETE` means this local plan only. No evidence/profile
acceptance, capture-time retrofit, registry matching, company edges, production
normalizer/derivative changes, cloud/IPFS/MCP/RAG/UI, commit, push, PR or demo update
is authorized or performed. County completeness and submission readiness stay
blocked.
