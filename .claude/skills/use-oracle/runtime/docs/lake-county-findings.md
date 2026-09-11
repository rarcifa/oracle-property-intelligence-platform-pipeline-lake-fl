# Lake County, FL — county profile

Written by `county-discovery` on 2026-09-09. Machine-readable catalog: `docs/lake-sources.yaml`.
County slug `lake`, FIPS 12069, Florida DOR county number 45.

Lake is a **bulk-first** county. Both of the sources a normal county onboarding scrapes per
parcel — the property appraiser site and the permit detail pages — are behind a Cloudflare
managed challenge. Everything published here comes from bulk downloads and open Esri
services instead, and the parts that could not be reached are named rather than estimated.

## 1. Appraiser portal

- Base URL `https://lakecopropappr.com`.
- **Correction to prior findings:** this host returned HTTP 200 from this egress on
  2026-09-09, contradicting an earlier record of a blanket 403. It was still not used as a
  source: the DOR roll carries the same assessed facts for all 215,806 parcels in one
  download, and per-parcel scraping of a county this size buys nothing the roll lacks.
- Access mode: not exercised. No browser flow was built, so
  `county-appraisal-onboarding`, `validate-county-transform` and `transform-v2-builder`
  were deliberately skipped. That substitution is recorded in `docs/lake-kit-deviations.md`.

## 2. Parcel identifier

- Official name: **Parcel ID**, with **Alternate Key** as the permit join.
- Format: `NN-NN-NN-NNNN-AAA-AAAAA`, 23 characters. The first four segments are numeric;
  the block and lot segments are **alphanumeric**. 26,616 of 215,806 parcels (12.3%) carry
  a letter there, for example `28-18-24-0500-00B-02500` and `29-19-26-0100-067-00D00`. A
  digits-only pattern silently rejects an eighth of the county; this was found by the seed
  builder failing closed rather than by inspection.
- Alternate Key: 7 digits. Both keys are unique across all 215,806 rows.
- On the permit layer the same parcel appears **undashed** in `Parcel_ID` and the Alternate
  Key appears in `Alternate_Key`. The Alternate Key is the better join: it is populated on
  100% of permit features.

## 3. Permit portal

Permits are **not** a county-level dataset here. One county service plus 14 independent
municipal systems.

- **Unincorporated Lake County** — Perconti CD Plus, exposed as an Esri MapServer layer
  through `utility.arcgis.com`. Open, no session, no challenge. 17,915 features, 17,671
  distinct permit numbers, 12,454 distinct parcels, fetched in 6.5 s at concurrency 4.
  `IN (...)` lists longer than about 50 values return HTTP 500, so paging is done by
  OBJECTID range.
- Two measured limits on that layer, both material:
  - **Jurisdiction.** A spatial test of every permit parcel against the 14 Census city
    polygons puts 45 of 17,915 features (0.25%) inside any city limit, and those are Lake
    County government facilities the county permits for itself. Mailing city is not a
    jurisdiction signal: 4,688 features carry a Clermont mailing address while sitting in
    unincorporated south Lake.
  - **Time.** `Permit_LastModDate` spans 2025-09-09 to 2026-09-08 — a 365-day rolling
    window. Only 846 of 17,671 permits (4.8%) were issued before 2024-09-09. This is a
    current-permit service, not a permit archive.
- **The 14 municipalities.** Exactly one, **Clermont**, has an open machine-readable
  portal: CentralSquare eTRAKiT 3, searchable by "AK NUMBER" which is the NAL Alternate
  Key, and its detail pages expose **contractor names** — the very field the county layer
  withholds. The other 13 are blocked by login, captcha, bot protection or TLS failure, or
  have no online search at all. Each has a named records-request route in
  `docs/lake-sources.yaml`.
- **Clermont is harvested.** A registered `etrakit` vendor module
  (`src/counties/lake/etrakit-adapter.mjs`) now backs the adapter key
  `src/counties/permit-profile.mjs` has always admitted, and permit year 26 is captured:
  4,132 permits enumerated over 2,656 parcels, benchmarked in §7. This is the only source
  of contractor of record anywhere in the county, and it covers one jurisdiction of
  fifteen — see the coverage snapshot, not this sentence, for what that means per
  jurisdiction.

**Permit linkage.** Of 17,671 distinct permits, 17,457 join an assessed parcel by
`ALT_KEY` and **214 do not**, across 119 distinct parcel keys absent from the roll. Those
are valid records and are reported separately in the coverage snapshot rather than dropped
or silently converted into "this property has no permits". The raw layer also carries 244
duplicate feature rows for the same permit and parcel, which the incremental merge collapses
by `(permit_number, alternate_key)`.

Permit vocabulary measured from the live layer: 113 distinct `Permit_Type` values, of which
`RF`, `RFC`, `RFR`, `ROC`, `ROR` are roofing (3,312 features; `RFR`, residential re-roof,
is 3,099 of them). Status vocabulary is APPLY, CANCEL, COED, EXPIRED, FINAL, INSPECT,
ISSUED, READY, RENEWED, REVOKE, VOID, closed_ni; the five open statuses are APPLY, INSPECT,
ISSUED, READY, RENEWED.

## 4. Bulk data sources

| Source | What it gives | Size | Measured |
|---|---|---|---|
| DOR NAL 2026P | 215,806 assessed parcels, owners, values, year built, 2 most recent sales | 18.3 MB zip, 114 MB CSV, 165 columns | 36 s download |
| DOR SDF 2026P | 37,020 sale records over 30,977 parcels | 0.8 MB zip | 3 s |
| DOR TPP/NAP 2026P | 33,346 tangible-personal-property business accounts with NAICS | 1.4 MB zip | 3 s |
| FL GIO parcel centroids 2025 | 210,935 Lake centroids | ids-only + OBJECTID ranges | 210,935 rows in ~10 s at concurrency 4 |
| Lake CD Plus permits | 17,915 features | OBJECTID ranges, 1,000/page | 6.5 s |

Only the **current** roll is published: the NAL folder exposes `2026P` alone. The DOR Map
Data archive does publish Lake parcel files back to `2005F`, but they are geometry only —
the 2010 file was downloaded and its attribute table holds exactly two fields, `CO_NO` and
`PARCEL_ID`, across 178,377 records. Attribute-bearing `PAR` files begin at `2024F`.

## 5. Usage-type vocabulary

DOR use codes, banded for the permit-eligibility branch. The county is overwhelmingly
residential: 136,516 single family (001), 25,667 vacant residential (000), 16,402 mobile
home (002), 6,802 residential other (009), 3,984 government (080), 3,576 condo (004).
Commercial is codes 10-39, industrial 40-49; those are the bands the eligibility branch
treats as permit-eligible.

## 6. Additional data sources

- **Business records** come from the DOR TPP roll: 33,346 accounts, 1,883 in construction
  NAICS 236/237/238, of which 44 are roofing contractors (238160). This is the county's own
  tangible-property roll, not a scrape.
- **Sunbiz** corporate registration is a Florida statewide bulk source and was **not**
  ingested: it is not in this assignment's acceptance criteria.
- **BBB** is gated. `bbb.org` answers 403 to this egress, and `use-oracle` requires BBB
  browser work to run on approved AWS-managed remote compute, which a deployment whose
  whole premise is no ongoing infrastructure cost does not have.

## 7. Source feasibility

Every bulk source is a download or a bounded Esri page walk, so the roll, the centroids,
the sales, the business accounts and the county permit layer together acquire in **under a
minute of network time**, far inside the 48-hour gate. Nothing there needed the
distributed-harvest decision.

Clermont's eTRAKiT is the one source that needs a real harvest, and it is now measured.

### Clermont eTRAKiT 3 — benchmark, 2026-09-11

Sixty-three requests at concurrency 1 and 2, zero failures. `measure` writes the full
record to `data/artifacts/permits/lake/<jobId>/throughput.json`.

| Phase | p50 | p95 | Failures | Notes |
|---|---|---|---|---|
| Session bootstrap | 759 ms | 2,085 ms | 0/3 | Yields the 5,035-entry registered-contractor directory |
| Permit search by parcel (`SITE_APN`) | 624 ms | 2,088 ms | 0/10 | 8.2 permits per permitted parcel, whole history in one response |
| Permit list by number prefix | 672 ms | 1,193 ms | 0/10 | 20 rows a page; every depth-2 prefix came back capped |
| Permit detail, concurrency 1 | 1,077 ms | 1,257 ms | 0/20 | 0.91 req/s, 854 KB a page |
| Permit detail, concurrency 2 | 1,145 ms | 2,585 ms | 0/20 | 1.55 req/s, 854 KB a page |

**Safe concurrency: 2.** Nothing degraded at 2, and 3 and 4 were not tried — this is a
municipal server and concurrency here is a politeness control, not a throughput knob.

**There is a second ceiling, and it is cumulative rather than instantaneous.** A harvest
pass of roughly 2,500 detail requests at concurrency 2, over about 80 minutes, ended with
the host accepting the TCP connection and never sending an HTTP response. Two unloaded
probes during and after that window returned HTTP 200 in about 2.0 s, which by
`county-ingest-run` §5 makes it load-induced and RETRYABLE, not a source-side defect: the
right response is to back off and resume, which is what the resume pass did at concurrency
1 with a 600 ms inter-request delay. The lever that stays inside this ceiling is the gap
between requests, not the worker count.

**History window, measured.** Permit-number year roots `15-` and `20-` return results
(earliest issue date observed 2015-01-02); `90-`, `95-`, `00-`, `05-`, `08-`, `10-` and
`12-` all return the portal's no-results notice. The searchable history is permit years
15 through 26 — twelve years, not an open-ended archive.

### Estimated full download

At concurrency 2 and the measured failure rate, one retry charged per failure:

| Scope | Requests | Estimate | Storage |
|---|---|---|---|
| Permit year 26, prefix enumeration + detail | 4,622 | **0.6 h** | ~3.6 GB raw HTML |
| Permit years 15–26, same method | ~66,000 | **8–9 h** | **~50 GB raw HTML** |
| Parcel-keyed over the 50,447 CLERMONT-mailing seed parcels | 54,579 | **5.0 h** | as above |

All three are **inside the 48-hour gate**, so `county-ingest-run` §2 does not require an
operator decision on time. The number that does deserve one is storage: 854 KB of raw HTML
per permit means the full twelve-year history costs about 50 GB on disk, and that, not
elapsed time, is what would bound a full-history run.

**Recommended mode: bulk artifact download, by prefix enumeration.** Both methods end at
the same detail pages, so they differ only in the search half — 490 prefix searches a year
against 50,447 parcel searches, a factor of about 103. Mailing city is not a jurisdiction
signal in Lake (§3), so a parcel-keyed pass would spend most of those 50,447 searches
proving that an unincorporated parcel is not Clermont's. Enumeration asks the portal what
it has instead of asking it about parcels it has never heard of. The parcel-keyed path is
implemented and registered all the same — it is the kit's shape, it is what a single
on-demand lookup needs, and it is measured above.

## 8. Risks

- **Cloudflare managed challenge** across the entire `lakecountyfl.gov` estate, including
  `www`, `c` and `gis`. Confirmed by `cf-mitigated: challenge` on every path. The Esri
  proxy works precisely because it is vendor-hosted and bypasses that estate. This is what
  removes contractor of record from the published data.
- **Rolling permit window.** Anything depending on deep permit history is a lower bound.
  Re-running the pipeline daily accumulates history going forward, which is exactly what
  the incremental mode is for, but it cannot recover what the window already dropped.
- **Release-year offset** between the 2026 roll and the 2025 centroid release leaves 4,871
  parcels (2.26%) without coordinates. They publish with null coordinates rather than being
  dropped.
- IPFS gateways `ipfs.io`, `dweb.link` and `w3s.link` return 429 to datacenter and VPN
  egress. Retrieval is proven against gateways that answer.
