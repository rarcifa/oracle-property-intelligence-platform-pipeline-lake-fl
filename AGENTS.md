# AGENTS.md — Oracle Property Intelligence Pipeline, Lake County FL

Assignment: https://github.com/prismteam-ai/oracle-property-intelligence-platform-pipeline-lake-fl (its README is the story).
It is scored by the soofi-xyz team kit's `slowking` agent; kit-usage conformance is judged by consulting `arceus`.
The point is to demonstrate how well we use the official Soofi team kit. The assignment README is the brief; verified facts are recorded below and in `pipeline/docs/lake-sources.yaml`.

## The kit is a global Codex plugin

- Agents and skills come from `soofi-xyz-team-kit@soofi-xyz-team-kit`, installed globally through Codex's plugin marketplace. Do not copy them into this repository.
- The expected installed version at the time of this migration is `0.46.1`. Check it with `codex plugin list`.
- Install or refresh from an official Soofi team-kit checkout with the commands from that checkout's `README.md`: `codex plugin marketplace add ./`, then `codex plugin add soofi-xyz-team-kit@soofi-xyz-team-kit`.
- In Codex, ask to spawn a named custom agent such as `arceus`, `oracle`, or `slowking`; do not use Claude slash-agent conventions.
- `pipeline/` is project code derived from the kit's self-contained Oracle runtime. It is retained here because it contains the Lake adapter, deterministic publication code, and test fixtures; it is not a second skill installation.
- `.mcp.json` records the Elephant development MCP catalog and needs Node 22.18+.

## Non-negotiable rules

1. **Kit only.** Start every task by spawning `arceus`; execute with exactly the agents and skills it names. Never improvise a stack, layout, workflow or publishing method that a kit skill already defines. If a skill does not fit, quote arceus and use the closest kit neighbour it names.
2. **Local only.** No `git push`, PR, GitHub secret, workflow dispatch, Filebase/IPFS publish, cloud deploy or account creation without an explicit "go" from the owner in the current conversation. A draft PR only when the owner says the submission is ready.
3. **Authorship.** Commits are authored and committed only as `rarcifa <ricardo.arcifa@cronoslabs.org>`. Never add `Co-Authored-By` or any AI/session trailer.
4. **Intake first.** Run `onboard-county`'s operator intake, present the routing plan (primary agent, supporting agents, skill per stage), wait for approval, then report after each stage.
5. **Honest completeness** (`use-oracle`): fail-closed readiness YAML, every source limitation recorded in the coverage snapshot, never fabricate contractor/BBB/sales data.
6. **Engineering baseline:** `apply-engineering-guidelines` applies to everything (TypeScript, Vitest, Prettier/ESLint, CDK-only IaC, Vercel AI SDK for LLM calls).

## Verified facts (updated 2026-09-11) — reuse, do not re-probe

- Filebase creds in `.env` (git-ignored); bucket `elephant-oracle-open-data-lake`; free plan = ONE IPNS name, already created: `oracle-open-data-lake` = `k51qzi5uqu5dgd1ekyyuhwggov571fjxof2p5ef4ke7enlq60k03r47fosb2un`. Plain S3 uploads get Filebase's own CIDv0; a CAR upload with metadata `import: car` pins exactly the CIDv1 DAG you computed.
- Sources: FL DOR Data Portal (NAL 215,806 parcels, SDF 37,020 sales 2025–26 only, TPP 33,346 businesses; only the current roll is published), FL GIO centroid FeatureServer (210,935 rows; use ids-only + OBJECTID ranges, offset paging breaks past 20k), Lake CD Plus permit layer (17,671 distinct permits; join on `Alternate_Key` = NAL `ALT_KEY`; window on `Permit_LastModDate`; `IN` lists > 50 return 500). Endpoints in `pipeline/docs/lake-sources.yaml`.
- Gated (403 from every egress): county permit detail pages, bbb.org, DBPR, Sunbiz search, lakecopropappr.com. Clermont's eTRAKiT permit details are accessible and the completed 2026 harvest contains 4,061 records; contractor coverage is Clermont-only.
- Gateways: `ipfs.io`, `dweb.link`, `w3s.link` 429 datacenter IPs (incl. GitHub runners); `gateway.pinata.cloud` and `gw.ipfs-lens.dev` work; `ipfs.filebase.io` supports CORS + Range.
- Prior immutable publication (2026-09-09): root `bafybeif7figvhmv7q7ykxxfcs3nbnjutjwistroiqtb433z3uhkmce7jau`, manifest `bafkreibfwqfcvonyswytxuej2rnzfjocr3yp5zuuu537n27jla4ylerwpy`.
- Rubric gates: PR to the designated repo, hosted runtime (localhost = 0/100), credentials, demo video. Functional points: Tenant view, Business view, Contractor view, semantic RAG Q&A, source-backed NL answers, data scale/coverage.

## Reference only

`~/Downloads/oracle-property-intelligence-platform-pipeline-lake-fl-main` — previous non-kit attempt (verified source adapters, CAR/manifest/verification code, spec). Read for facts; do not copy wholesale.
