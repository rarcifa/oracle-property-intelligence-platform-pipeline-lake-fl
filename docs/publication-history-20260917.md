# Historical publication, recovery and provider attempts

These dated attempts are retained evidence, not current submission claims.
The [September 17 handoff](submission-handoff-20260917.md) and current README
identify the selected preview, completed public GET proof and remaining holds.

The owner-approved Pinata Free key has been created with pin creation/list/status
permissions only and its JWT is configured locally. A read-only PSA request on
2026-09-16 returned HTTP 403 with `PAID_FEATURE_ONLY`: "You must be on a paid plan
to pin by CID". The Pinata secondary-provider route therefore remains blocked
by plan capability, not an absent token. No paid upgrade, alternate provider or
publication is authorized by credential setup. Pinata's [plan comparison](https://pinata.cloud/pricing)
does not include pin-by-CID or native CAR import on Free; an ordinary CAR-file
upload would not independently retain its inner artifact CIDs.

The owner subsequently configured an IPFS + Filecoin Lighthouse Lite account:
500 GB storage at $12/month, with the next billing date shown as 2026-10-16.
Its supplied `IPFS_API_KEY` passed documented read-only inventory and usage
requests (HTTP 200, zero files/usage, 536,870,912,000-byte allowance). The owner's
key is displayed as `admin`; it is not described as a granular pin/read-only key.
No key value is included in this repository or the documentation corpus.
The explicit `--secondary-provider lighthouse` branch uses Lighthouse's
[same-CID pin API](https://docs.lighthouse.storage/how-to/pin-cid), not Pinata's PSA.
Request acceptance, reconciled inventory/metadata and verified retention are
separate states. Registration alone cannot advance gateway/history/IPNS promotion;
the live replication outcome is recorded below. On 2026-09-17 the owner approved
the existing $12/month Lighthouse plan as a specific exception to the $5/month
ceiling. The $25 cumulative one-time ceiling and all other constraints remain
unchanged; this is not approval for a different paid tier or remote execution.
Live publication still needs its own exact-target approval. The subscription was established
by the owner; the pipeline did not purchase, renew, cancel or change it. Data
retention depends on an active provider plan, not an infinite-storage guarantee.
The Lighthouse adapter and signed replication scope's local verification on
2026-09-17 passed all 994 pipeline tests (82 files), including provider/credential isolation, interrupted-request
reconciliation, 20-second request deadlines, atomic private checkpoints and
rejection of unsupported retention receipts. Arceus confirmed this bounded
Oracle-adapter route and reviewed the independent scope boundaries; this is
code verification, not live publication proof.

The existing publisher also supports a separately approved
`--execution-scope replication-only` target: the three immutable CAR uploads and
root/manifest/archive pin requests, with actual accepted/registered/uncertain
evidence. Its terminal ledger branch is `REPLICATION_REQUESTS_RECORDED`, with
retention unverified and promotion held. That scope cannot verify gateways,
append successful history, repoint IPNS or change latest/row hashes/RAG selection;
terminal retries return evidence locally without repeating remote effects.
Omitted scope keeps old full-publication signatures unchanged. This local repair
does not execute uploads or pins and does not satisfy public publication by
itself; see [the scoped handoff](../docs/runbook.md#replication-only-human-approval).

On 2026-09-17 the owner removed our added per-commit personal-signing requirement
for normal publication and replication. The publisher now accepts an external,
exact-target human approval manifest recording the owner's actual consent; no
private key or repeated signing command is required. This follows the official
kit's human-approval manifest pattern, not cryptographic authentication. Target
bytes/digests/CIDs, destinations, active window, nonce reservation, current
runtime provenance and predecessor checks remain enforced. Legacy signed
approvals and the existing signed recovery evidence remain valid; official
coverage-only signing remains separate. Retention, gateway, history and IPNS
verification gates are unchanged. Full publication needs approval for its own
full target/actions; replication consent never transfers to promotion. This
change alone is not completed publication, and no full-approved manifest or
full live invocation was created by the removal.

The owner-approved, no-signing continuation from `66bfce0` completed on
2026-09-17 at 13:41:32 UTC with exit 0. All three existing Filebase CAR objects
were reconciled with complete DAG readback, and all three Lighthouse inventory/
metadata registrations matched the derived DAG block sizes, including the archive.
The ledger reached `REPLICATION_REQUESTS_RECORDED`, revision 22; the prior accepted
pin requests were preserved rather than repeated, and no new primary uploads
were needed. The same immutable manifest/CIDs remain unchanged. IPNS stayed at
sequence 13; successful history, latest/row hashes and RAG selection were not
promoted. Retention remained open at that boundary;
this is successful limited replication reconciliation, not `FINALIZED` publication.
See [the recorded reconciliation](../artifacts/replication-reconciliation-20260917T134256Z.json).

Standalone public GET verification completed at 13:52:41 UTC: 39 of the 40
listed artifacts, plus the manifest itself, matched size/SHA-256 through both
Filebase and Pinata public gateways. This includes directory raw blocks,
all query/business/permit tables, sample extracts and every data shard.
Only `snapshot.car` failed the initial checks: both gateways exceeded the
60-second deadline; IPFS Lens returned a fetch failure. The longer archive-only
check then matched the manifest's 341,012,658 bytes and SHA-256 on Filebase,
but Pinata returned HTTP 429. This historical gap was closed by the bounded
[15:17 CAR readback](../artifacts/public-gateway-archive-readback-20260917T151703Z.json):
both Filebase and Pinata returned the full matching object. These results do not advance the publisher or prove
Lighthouse-local retention. See
[the every-CID results](../artifacts/public-gateway-readback-20260917T135241Z.json)
and [the archive-only result](../artifacts/public-gateway-archive-readback-20260917T135314Z.json).

The signed `b3d92c6` live attempt on 2026-09-17 stopped twice on a TLS abort
before complete primary CAR readback. The root object's size/CID metadata was
present, but its bytes were not verified; archive/manifest objects were absent
and no Lighthouse pins were requested. Authenticated S3 CAR Range probes
returned HTTP 200 with the full object length, not partial responses. IPNS,
successful history and dataset selection remain unchanged. The local repair
now verifies an existing object by full streamed byte/size/SHA-256 comparison
before any PUT, permits creation only on definite absence, rechecks the signed
authorization/predecessor immediately before creation, and disables SDK PUT
retries. Ten-minute request/body deadlines produce sanitized byte-count errors;
there is no Range or sampled-byte fallback. Offline regression checks establish
that safety contract, not repaired live transport or publication. The old signed
checkout/object remain preserved; a changed candidate needs exact recorded human
approval before live execution. Replication-only approval no longer needs signing.

On 2026-09-17 the signed `9218ffc` retry returned S3 GET HTTP 500 before
receiving bytes, with zero PUTs or pins. Read-only diagnosis ruled out optional
SDK checksum headers: both request variants returned 500. Filebase's public
CAR export succeeded, but serializes blocks differently from the original
upload CAR. The repaired helper verified every one of the 1,352 frozen DAG
blocks in a complete streamed readback; see the
[diagnostic](../artifacts/filebase-readback-20260917T110926Z.json).
The explicitly signed `primaryReadback: imported-dag` contract binds the
existing key through authenticated HEAD and verifies all remote roots, block
bytes and hashes before recording an effect. Original upload transport
digests remain distinct from observed export digests. Omitted mode retains
legacy transport GET behavior; there is no HTTP-500 fallback. Only definite
HEAD absence permits freshly guarded creation. This diagnosis performed no
uploads, pins, ledger advancement or IPNS/history/data promotion. The changed
candidate required its matching human signature before live effects; provider
gateway readback is not independent retention or two-gateway publication proof.

The owner signed and authorized `e91a76d` for one replication-only invocation on
2026-09-17. Filebase imports and complete DAG readbacks succeeded: the existing
root was reconciled, and the archive and manifest were created and verified.
Lighthouse acknowledged all three same-CID requests with HTTP 200; root and
manifest registrations reconciled. The archive validation stopped the invocation
with exit 1: Lighthouse's reported 341,078,214 bytes exactly equal the frozen
archive DAG's block bytes, not the manifested snapshot file's 341,012,658 bytes. Read-only
postflight found all three expected CIDs/names in its account inventory, with public metadata.
This identifies a size-semantics mismatch, not proof of verified retention or
independent byte retrieval. That failed attempt's ledger remains `MANIFEST_UPLOAD_RECORDED`,
revision 21; no retry, successful-history append, IPNS/latest/row-hash/RAG
selection change, push or PR edit occurred. See the
[sanitized execution evidence](../artifacts/filebase-replication-20260917T122123Z.json)
and the byte-identical, 40-object
[artifact manifest](../artifacts/manifest-20260916T181000Z.json). Repository manifest
delivery is complete; retention and every-object two-gateway proof remain open.

The subsequent owner-approved local correction derives Lighthouse's expected
registration size from each frozen CAR's unique, hash-validated, root-reachable
DAG blocks. An explicit `expectedDagBytes` contract checks provider metadata
against that value; legacy size checks and Pinata behavior remain unchanged.
The [offline replay](../artifacts/lighthouse-dag-size-replay-20260917T123212Z.json)
matches all three recorded provider sizes, including the archive, with zero
network calls or ledger writes. Manifest file sizes/digests, signed transport
fields, receipt formats and retention/promotion guards are unchanged. This is
local repair evidence, not a live retry or completed publication.

Authenticated Filebase readback also found the existing IPNS
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

The owner approved scoped sequence-13 recovery on 2026-09-16. Its local
implementation uses Oracle's cross-environment handoff contract and the kit's
existing Ed25519 human-signature primitive. It preserves the genuine manifest,
root block, coverage and query-table bytes with two independent current
readbacks, and binds their evidence, destination and last-known history to a
separate `externally_observed_recovered` receipt. Original approval, historical
gateway readback and successful-publication receipt remain explicitly unknown;
no historical run is marked successful. The owner signed the recovery request
and explicitly trusted its public key; local acceptance completed at
`2026-09-16T19:09:34.942Z` without modifying IPNS or history. Its accepted receipt
digest is `sha256:e8da5893fdf57eb72a82682acfdb5c2ad6bbc74261d39d5b45996ff9d4d97e71`.
Only that verified receipt can anchor a later separately authorized publication;
the new publication approval also binds the recovery receipt's digest.
Live name/root/sequence drift is rejected before upload, pin creation or
promotion. Recovery itself has no pin, IPNS write, deploy or harvest action.
See the [operator recovery procedure](../docs/runbook.md#external-predecessor-recovery).

Publication accounting distinguishes the legacy 2,060 parcel-matched business
accounts from the modern all-account table's 33,346 queryable source accounts.
The new table's actual Parquet row count and unique, non-empty account IDs are
checked before publication. Retaining 31,286 previously unmatched accounts is
new query availability, not a fresh source capture or verified legal identity.
