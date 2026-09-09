# Master prompt — Oracle Property Intelligence Pipeline, Lake County FL (kit-driven rebuild)

You are working in a fresh repository at ~/Downloads/oracle-lake-fl-kit for the hiring assignment
https://github.com/prismteam-ai/oracle-property-intelligence-platform-pipeline-lake-fl (README = the story).
The assignment is scored by the soofi-xyz team kit's `slowking` agent, and kit-usage conformance is judged by
consulting `arceus`. The point of this exercise is to demonstrate how well we use the EXISTING team kit.

## Non-negotiable working rules

1. **Kit only.** Every piece of work is routed by `/arceus` and executed by the agent(s) and skill(s) it names.
   Do not improvise a stack, a workflow, a folder layout or a publishing method that a kit skill already
   defines. If arceus says a skill does not fit, quote it and choose the closest kit neighbour it names.
2. **Local only.** No `git push`, no PR, no GitHub secrets, no workflow dispatch, no cloud deploy, no account
   creation, without an explicit "go" from me in this conversation. Filebase publishing to IPFS is allowed
   (credentials already exist, see below). A draft PR is opened only when I say the submission is ready.
3. **Authorship.** Every commit is authored and committed as `rarcifa <ricardo.arcifa@cronoslabs.org>`
   (already the global git identity). Never add `Co-Authored-By`, `Claude-Session` or any AI trailer.
4. **Ask before assuming.** Run the kit's intake first (arceus → `onboard-county` operator intake).
   Present the routing plan (primary agent, supporting agents, skills per stage) and wait for my approval
   before building. After that, report at the end of every stage with what the skill produced and what
   it could not, then continue.
5. **Honesty over completeness.** The kit's `use-oracle` contract is fail-closed and "honest completeness":
   record every source limitation in the readiness YAML and coverage snapshot; never fabricate contractor,
   BBB or sales data.

## How to start

1. `/arceus Route the Lake County FL oracle assignment: <paste the story README acceptance criteria>` —
   read its recommendation. Expected primary: `oracle` (with `use-oracle`, `onboard-county`,
   `county-discovery`, `county-readiness-preflight`, `county-seed-data`, `county-permit-adapter`,
   `county-ingest-run`, `query-db-loading-matching`, `county-open-data-publish`,
   `county-query-table-publish`, `deploy-open-data-mcp`, `bootstrap-oracle-infra`,
   `monitoring-county-ingestion`, `sunbiz-corporate-ingest`, `bbb-harvest`, `overture-places-ingest`).
   Expected supporting: `apply-engineering-guidelines` (always), `metagross` + `build-frontend-backends`
   (UI), `espeon`/`alakazam` + `build-rag-systems` / `build-ai-agents` (agent Q&A), `donphan` +
   `use-elephant-mcp` (exploration checks), `integrate-ci-cd`, `slowking` (self-assessment before submission).
2. Follow `onboard-county` in order: intake → discovery → readiness preflight → seed → appraisal/transform
   → permit adapter → ingest run → enrichment → load/match → publish (open data + query table) → MCP wire →
   monitoring. Use `bootstrap-oracle-infra` for the local Restate + Postgres stack (Docker is installed).
3. Story-specific requirements the kit skills must be driven to satisfy (they are in the README):
   continuous/incremental runs with run history + deltas; CIDv1 base32 for every published object; a per-run
   artifact manifest (cid, name, size, codec, sha256, optional origins); IPNS name + resolved CID recorded per
   run; prior CIDs immutable; a CAR for every directory root; retrieval proven from ≥2 independent public
   gateways with byte/digest match; DuckDB for querying; MCP + agent + UI; Oracle carries no ongoing
   infrastructure cost by default (Restate/Postgres are local ingestion-time tools; published data on IPFS is
   the read path). Where a kit skill does not cover a story requirement (CAR, manifest, gateway verification,
   CIDv1), extend the skill's output in its own conventions and say so explicitly.
4. Run `/slowking` against the local result as a self-assessment before I decide on deployment/PR. Note that
   Slowking's runtime gate requires a hosted URL; a local runtime is 0/100 on that gate — report it as such.

## Facts already established (verified 2026-09-08/09; reuse, do not rediscover)

Credentials and identities
- Filebase: `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` in
  ~/Downloads/oracle-property-intelligence-platform-pipeline-lake-fl-main/.env (copy to the new repo's .env,
  git-ignored). Bucket `elephant-oracle-open-data-lake` exists (Filebase free plan, private bucket).
- Filebase free plan allows exactly ONE IPNS name. It exists: label `oracle-open-data-lake` =
  `k51qzi5uqu5dgd1ekyyuhwggov571fjxof2p5ef4ke7enlq60k03r47fosb2un`. Do not create a second label
  (`oracle-query-table-lake` will fail with ERR_TOO_MANY_NAMES); address the query table as
  `/ipns/<name>/…` and by CID, and record the limitation.
- Filebase assigns its own CIDv0 (`Qm…`) to plain S3 uploads. To publish exactly the CID you compute
  (CIDv1, raw leaves), upload a CAR with metadata `import: car` (`x-amz-meta-import: car`); this is proven
  to pin the whole DAG and make `/ipfs/<root>/<path>` resolvable.
- GitHub: fork `rarcifa/oracle-property-intelligence-platform-pipeline-lake-fl` exists (contains the previous
  attempt; ignore it). I only have READ on prismteam-ai; a PR later must come from the fork.
- AWS credentials exist locally (account 122610508924, region us-east-2) — do not deploy without my go.
- No Anthropic key is in the shell yet; I will export `ANTHROPIC_API_KEY` when the agent needs it.

Sources (Lake County, FL = DOR county code 45)
- FL DOR tax roll via the Data Portal SharePoint REST:
  `https://floridarevenue.com/property/dataportal/_api/web/GetFolderByServerRelativeUrl('<encoded path>')/Files`
  under `/property/dataportal/Documents/PTO Data Portal/Tax Roll Data Files/{NAL,SDF,NAP}/2026P/` →
  `Lake 45 Preliminary NAL 2026.zip` (18.3 MB, 215,806 parcels), `… SDF 2026.zip` (37,020 sales, 2025–2026 only),
  `… TPP 2026.zip` (33,346 business accounts with NAICS; 238160 = roofing contractors). Only the current roll
  is published; sales history therefore covers 2025–2026 only (10-year tenure cannot be proven — say so).
  `Map Data/<year>F/` has yearly Lake `*_pin.zip` (parcel ids only) and `*_par.zip` from 2024F (NAL attrs); not enough for 10-year tenure.
- FL GIO parcel centroids (lat/lon + PARCEL_ID + ALT_KEY, 2025 release):
  `https://services9.arcgis.com/Gh9awoU677aKree0/arcgis/rest/services/Florida_Statewide_Parcel_Centroid_Version/FeatureServer/0`
  `WHERE CO_NO=45` → 210,935 rows. Offset paging fails past 20,000 rows; use `returnIdsOnly` + OBJECTID range
  queries (2,000/page, 4 concurrent ≈ 49 s total).
- Lake County permits (CD Plus "Permit Parcels", Esri proxy):
  `https://utility.arcgis.com/usrsvcs/servers/365d9a169bc34110a3db2157c76f6c95/rest/services/Individual/CDPermitParcels/MapServer/0`
  17,915 features = 17,671 distinct Permit_Number (multi-parcel permits repeat); fields Permit_Number,
  Alternate_Key (= NAL ALT_KEY, the join), Parcel_ID (NAL id without separators), Permit_Type (RFR = re-roof
  residential), Permit_Desc, Permit_Status (open = ISSUED/INSPECT/APPLY/READY/RENEWED), PermitApplied/
  Approved/Issued_Date, CO_Date, Permit_LastModDate (epoch ms; window on it for incremental), PermitURL,
  polygon geometry. `Permit_Number IN (…)` lists of 200 return HTTP 500; use ≤50 or scan by OBJECTID range.
  Counts: 3,289 roofing, 3,650 open, 243 open roofing, 2 open roofing > 5 years; ~40 features change per day.
- Gated (HTTP 403 Cloudflare from every egress tried, incl. GitHub runners and VPN): permit detail pages
  `c.lakecountyfl.gov/.../permit_report.ashx` (contractor name), bbb.org, DBPR downloads, Sunbiz search,
  lakecopropappr.com. Sunbiz bulk (ftp.sunbiz.org / sftp.floridados.gov) untested from a clean egress.
- IPFS gateways: `ipfs.io`, `dweb.link`, `w3s.link`, `nftstorage.link` return 429 to datacenter IPs (GitHub
  runners and my VPN, AS212238 Datacamp). `gateway.pinata.cloud` and `gw.ipfs-lens.dev` serve fine;
  `ipfs.filebase.io` (vendor) supports CORS + Range. Sequential requests with pauses avoid bursts.
- Already published, immutable, may be cited as prior history: run root
  `bafybeif7figvhmv7q7ykxxfcs3nbnjutjwistroiqtb433z3uhkmce7jau`, manifest
  `bafkreibfwqfcvonyswytxuej2rnzfjocr3yp5zuuu537n27jla4ylerwpy` (2026-09-09).

Rubric facts (from the kit's evaluate-candidate-* skills)
- Gates before any score: PR to the designated repo, hosted runtime (localhost/tunnels = 0/100), credentials,
  demo video. Functional outcome (40) decomposes for this assignment into: Tenant view, Business view,
  Contractor view, semantic RAG Q&A, source-backed natural-language answers, data scale/coverage (toy data
  scores extremely low). Speed is measured to the latest commit. Kit-usage conformance is scored by
  arceus routing + read-only reviews from the expected builder agents.

## Reference material (read, do not copy wholesale)

~/Downloads/oracle-property-intelligence-platform-pipeline-lake-fl-main — previous non-kit attempt. Useful
files: docs/superpowers/specs/2026-09-08-oracle-lake-fl-pipeline-design.md (verified source analysis),
docs/sources.md (measured constraints), packages/pipeline/src/sources/*.ts (working source adapters with
tests), packages/pipeline/src/ipfs/*.ts (CAR/manifest/verification code), packages/server/test/fixtures.
The kit itself is installed at ~/.claude/team-kit/soofi-xyz-team-kit (agents in ~/.claude/agents, skills in
~/.claude/skills; refresh with the old repo's scripts/install-team-kit.sh).

Begin with the arceus routing call and the onboard-county intake questions.
