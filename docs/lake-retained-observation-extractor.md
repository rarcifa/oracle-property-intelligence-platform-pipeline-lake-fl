# Offline retained-permit observation extractor

This local stage adds an isolated, versioned Clermont HTML observation extractor
and sanitized regression fixtures. It does not replace the production permit
normalizer, import into the harvest path, rebuild a derivative, accept a source
profile, or enable a roofing/status/company/license conclusion.

Arceus routed the work to Oracle with `apply-engineering-guidelines`,
`use-oracle`, and `county-permit-adapter`, restricted to captured-fixture
extraction. Arceus's kit-fit verdict: “No clean end-to-end kit match exists for
retrospective offline observation extraction.” The adapter skill is the closest
neighbour; its live probing, harvest, deployment, loading and publication steps
are excluded.

## Boundary and provenance

The input is the unchanged, previously verified 48-record Clermont sample:
four records per year, 2015–2026. The prior review packet, candidate list,
certified status bindings, production source digests and seven existing local
repair files are frozen before implementation. This is not a new capture
certification or a full historical-archive rehash.

Real observations and source-identity mappings remain in a private implementation
packet. Repository fixtures reconstruct only the relevant captured control and
Telerik table structures, with conspicuously synthetic identifiers, names,
contact details and free text. They are not real property records. Adversarial
test mutations are explicitly synthetic, not additional acquired captures.

## Observation contract

- Require one explicit source-rendered permit number matching the routing key.
  A missing number never becomes the expected work key; duplicate, missing and
  mismatched evidence stays held.
- Read Telerik's separate `_ctl00_Header` table, not the data table's hidden
  dummy header. Preserve original headings, column positions, all contacts and
  roles, row evidence and unknown/ambiguous section outcomes.
- Keep `Scheduled Date`, inspection-event `Completed`, both `Time` columns and
  safe exposed inspection row identifiers separate. Do not fetch More Info,
  serialize session/event-handler material, or convert an inspection event into
  permit or roof completion.
- Preserve source lifecycle labels and raw strings. A source `Finaled Date` is
  not three independently observed lifecycle dates. A future officially accepted
  profile might establish one valid close/completion anchor; three distinct
  dates are not a permanent requirement. No such profile is accepted here.
- Validate calendar syntax without inventing source chronology. Future scheduled
  inspections and expirations are not automatically impossible dates. Invalid
  calendars remain quarantined with raw provenance.
- Preserve raw scope and contact/license omissions and origins. Text or a
  directory candidate is not a dedicated printed-license field, official
  licensing verification, or canonical company identity.
- Keep per-record `capturedAt` null unless an explicit verified per-record
  receipt binds that timestamp to the exact raw digest. No such receipt exists
  for this sample. Never substitute directory, partition, certification, export
  or filesystem times.
- Conserve the seven evidence states per field; distinguish retained
  observations from accepted decision evidence. All production conclusions
  remain null/`needs_review`, with source-profile acceptance and decision
  promotion false.

## Verification and unchanged holds

Run the focused TypeScript/Vitest fixtures, applicable pipeline regressions,
strict type checking with `pipeline/tsconfig.observations.json`, and actual
ESLint/Prettier. The extractor is replayed twice over the same verified source
bytes; observation artifacts and state counts must match exactly. The private
stage packet records actual outcomes and input/output/code hashes.

`LOCAL_OFFLINE_EXTRACTOR_COMPLETE` means this isolated local implementation only.
County completeness, accepted lifecycle/roof scope, current-status freshness,
official temporal company/license identity and submission readiness remain
blocked. CD Plus is unreviewed in this stage; thirteen other municipal coverage
gaps remain unknown/null, not zero. Existing valid built-year estimates remain
low-confidence proxies, not definitive roof ages or proof of replacement
absence.

No production normalizer/capture/derivative/profile changes, network requests,
fresh harvest, timestamp retrofit, registry matching, company edges, cloud/IPFS,
RAG/UI, commit, push or PR update are authorized by this stage.
