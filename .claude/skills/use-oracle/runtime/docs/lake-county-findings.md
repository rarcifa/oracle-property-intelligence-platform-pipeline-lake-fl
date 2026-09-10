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

Every source used is a bulk download or a bounded Esri page walk, so the full county
acquires in **under a minute of network time**, far inside the 48-hour gate. Nothing needed
the distributed-harvest decision.

The one source that would need a real harvest is Clermont's eTRAKiT, at roughly one request
per parcel. That is catalogued as discovered but unharvested, with its throughput
unmeasured, rather than claimed.

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
