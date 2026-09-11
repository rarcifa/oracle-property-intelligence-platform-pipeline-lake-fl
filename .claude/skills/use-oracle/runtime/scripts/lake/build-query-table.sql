-- Lake County query-table consolidation.
--
-- One row per assessed parcel, joining the DOR NAL roll (the parcel
-- denominator) to GIO centroids, DOR SDF sales, the CD Plus permit layer,
-- Clermont's eTRAKiT permits and the DOR TPP business roll. Column order and types must match
-- src/counties/lake/query-table.mjs LAKE_QUERY_TABLE_SCHEMA_FIELDS exactly;
-- scripts/lake/build-query-table.mjs asserts that after the write.
--
-- Parameters are substituted by the driver: $DOWNLOAD_DIR, $OUT_PARQUET, $AS_OF_YEAR.

CREATE OR REPLACE VIEW nal AS
  SELECT * FROM read_csv_auto('$DOWNLOAD_DIR/NAL45P202601.csv', header=true, all_varchar=true);

-- The GIO release carries a small number of repeated ALT_KEY values (measured:
-- 210,935 rows, 979 fewer distinct keys). A repeat would fan the parcel join out
-- and break the rows == distinct-folio gate, so exactly one centroid per key is
-- kept, chosen deterministically by the lowest coordinate pair.
CREATE OR REPLACE VIEW centroid AS
  SELECT alt_key, min(lat) AS lat, min(lon) AS lon FROM (
    SELECT alt_key, TRY_CAST(latitude AS DOUBLE) lat, TRY_CAST(longitude AS DOUBLE) lon
    FROM read_csv_auto('$DOWNLOAD_DIR/centroids.csv', header=true, all_varchar=true)
    WHERE latitude <> '' AND longitude <> ''
  ) GROUP BY alt_key;

CREATE OR REPLACE VIEW permit_cdplus AS
  SELECT * FROM read_csv_auto('$DOWNLOAD_DIR/permits.csv', header=true, all_varchar=true);

-- Clermont's eTRAKiT permits, exported by
-- `scripts/lake/clermont-permits.mjs export`. The file is optional: a checkout
-- that has never run the Clermont harvest still consolidates, it just has no
-- contractor of record. read_csv_auto cannot express "this file may be absent",
-- so the driver writes an empty header-only file when the harvest has not run
-- (docs/runbook.md), and the union below is the same either way.
CREATE OR REPLACE VIEW permit_clermont AS
  SELECT * FROM read_csv_auto('$DOWNLOAD_DIR/clermont-permits.csv', header=true, all_varchar=true);

-- Both permit sources, one shape. The county layer covers unincorporated Lake
-- on a rolling 365-day window and carries no contractor; Clermont's portal
-- covers one municipality with real permit history and names the contractor of
-- record. They are unioned rather than kept apart because a parcel's permit
-- count should mean the same thing whichever jurisdiction issued the permit,
-- and `source_system` keeps the provenance of every row.
--
-- Permit numbers are only unique WITHIN a source - Clermont numbers permits
-- `YY-NNNN` and the county uses `YYYYMMDDNN` - so every DISTINCT count below is
-- taken over source_system plus permit_number, never permit_number alone.
CREATE OR REPLACE VIEW permit AS
  SELECT permit_number, alternate_key, permit_type, permit_desc, permit_status,
         applied_date, approved_date, issued_date, co_date, last_modified,
         permit_url, is_roofing, is_open, days_open,
         'lake_cdplus_permits'  AS source_system,
         CAST(NULL AS VARCHAR)  AS contractor_name,
         CAST(NULL AS VARCHAR)  AS contractor_license
  FROM permit_cdplus
  UNION ALL
  SELECT permit_number, alternate_key, permit_type, permit_desc, permit_status,
         applied_date, approved_date, issued_date, co_date, last_modified,
         permit_url, is_roofing, is_open, days_open,
         source_system, contractor_name, contractor_license
  FROM permit_clermont;

CREATE OR REPLACE VIEW sdf AS
  SELECT * FROM read_csv_auto('$DOWNLOAD_DIR/SDF45P202601.csv', header=true, all_varchar=true);

CREATE OR REPLACE VIEW tpp AS
  SELECT * FROM read_csv_auto('$DOWNLOAD_DIR/NAP45P202601.csv', header=true, all_varchar=true);

-- Permits collapse to one row per parcel. days_open is recomputed here rather
-- than trusted from the harvest so the published number is always as-of the
-- export, not as-of the fetch.
CREATE OR REPLACE VIEW permit_agg AS
SELECT
  alternate_key,
  count(DISTINCT concat_ws(':', source_system, permit_number))              AS permit_count,
  count(DISTINCT CASE WHEN lower(is_roofing)='true'
                      THEN concat_ws(':', source_system, permit_number) END)      AS roofing_permit_count,
  count(DISTINCT CASE WHEN lower(is_open)='true'
                      THEN concat_ws(':', source_system, permit_number) END)      AS open_permit_count,
  count(DISTINCT CASE WHEN lower(is_open)='true' AND lower(is_roofing)='true'
                      THEN concat_ws(':', source_system, permit_number) END) AS open_roofing_permit_count,
  count(DISTINCT CASE WHEN source_system <> 'lake_cdplus_permits'
                      THEN concat_ws(':', source_system, permit_number) END) AS municipal_permit_count,
  max(CASE WHEN lower(is_open)='true'
      THEN date_diff('day', TRY_CAST(coalesce(issued_date, applied_date) AS DATE), current_date)
      END)                                                                 AS longest_open_permit_days,
  max(coalesce(issued_date, applied_date))                                 AS latest_permit_date,
  max(CASE WHEN lower(is_roofing)='true' THEN co_date END)                        AS roof_co_date,
  -- Only a roofing permit that is no longer open is evidence of a roof.
  --
  -- An issued permit means the work was started or merely planned; it becomes
  -- evidence of a re-roof when it closes. Counting an open one made the roof
  -- read as NEW: a permit issued nine years ago and never closed published as
  -- `roof_age_years: 9` on a house built in 1974, so the parcel with the
  -- strongest possible lead signal — an old roof with roofing work stalled
  -- open for years — was ranked as recently re-roofed and dropped out of every
  -- aged-roof query. Where a roofing permit is still open the roof is the one
  -- the building has always had, so the age falls back to `year_built`, which
  -- `roof_age_basis` then reports honestly.
  max(CASE WHEN lower(is_roofing)='true' AND lower(is_open)<>'true'
      THEN issued_date END)                                                AS roof_issued_date
FROM permit
WHERE alternate_key IS NOT NULL AND alternate_key <> ''
GROUP BY 1;

-- Contractor of record, per parcel, from the one source in the county that
-- publishes it. The value carried forward is the contractor on the most
-- recently dated permit, so `contractor_name` answers "who worked here last"
-- rather than an arbitrary pick; parcels with several contractors keep the
-- count so a single name is never read as the only one.
CREATE OR REPLACE VIEW contractor_agg AS
SELECT
  alternate_key,
  arg_max(contractor_name, coalesce(issued_date, applied_date, ''))         AS contractor_name,
  count(DISTINCT contractor_name)                                          AS distinct_contractor_count
FROM permit
WHERE contractor_name IS NOT NULL AND contractor_name <> ''
  AND alternate_key IS NOT NULL AND alternate_key <> ''
GROUP BY 1;

CREATE OR REPLACE VIEW sale_agg AS
SELECT PARCEL_ID, count(*) AS sale_records_in_window
FROM sdf GROUP BY 1;

-- TPP business accounts are located by their situs address. The roll gives no
-- parcel key, so the join is on a normalized street+zip pair and is reported
-- as an address match, never as a parcel-level assertion.
CREATE OR REPLACE VIEW tpp_agg AS
SELECT
  upper(trim(PHY_ADDR))                                                    AS addr,
  trim(PHY_ZIPCD)                                                          AS zip,
  count(*)                                                                 AS business_account_count,
  -- The roll carries NAICS and the account name for every row, and neither was
  -- published: the business view could say activity exists at an address but not
  -- what kind or whose. Both are public record in the same file the counts come
  -- from, so withholding them made the signal weaker for no reason.
  string_agg(DISTINCT trim(NAICS_CD), ',' ORDER BY trim(NAICS_CD))         AS business_naics_codes,
  string_agg(DISTINCT trim(OWN_NAM), ' | ' ORDER BY trim(OWN_NAM))         AS business_names,
  -- NAICS 238160 is roofing contractors. The county's own permit pages hide
  -- contractor of record behind a 403, so this is the only contractor-shaped
  -- signal obtainable from a published source.
  count(*) FILTER (WHERE trim(NAICS_CD) = '238160')                        AS roofing_business_count
FROM tpp
WHERE PHY_ADDR IS NOT NULL AND trim(PHY_ADDR) <> ''
GROUP BY 1, 2;

-- The in-county city vocabulary comes from the roll's own situs cities, so an
-- owner mailing city is compared against places that actually exist in Lake.
CREATE OR REPLACE VIEW in_county_city AS
SELECT DISTINCT upper(trim(PHY_CITY)) AS city FROM nal WHERE trim(PHY_CITY) <> '';

COPY (
  SELECT
    substr(sha256(concat('lake:', n.PARCEL_ID)), 1, 32)                     AS property_id,
    CAST(NULL AS VARCHAR)                                                   AS property_cid,
    n.PARCEL_ID                                                             AS request_identifier,
    n.PARCEL_ID                                                             AS parcel_identifier,
    n.ALT_KEY                                                               AS alt_key,
    'lake_dor_roll'                                                         AS source_system,
    'Lake'                                                                  AS county_name,
    'FL'                                                                    AS state_code,
    nullif(trim(n.PHY_ADDR1), '')                                           AS address_street,
    nullif(trim(n.PHY_CITY), '')                                            AS address_city,
    nullif(trim(n.PHY_ZIPCD), '')                                           AS address_zip,
    c.lat                                                                   AS latitude,
    c.lon                                                                   AS longitude,
    TRY_CAST(n.LND_SQFOOT AS DOUBLE)                                        AS lot_area_sqft,
    TRY_CAST(n.LND_SQFOOT AS DOUBLE) / 43560.0                              AS lot_size_acre,
    use_band.band                                                           AS property_type,
    use_band.band                                                           AS property_usage_type,
    nullif(trim(n.DOR_UC), '')                                              AS dor_use_code,
    CASE WHEN TRY_CAST(n.ACT_YR_BLT AS INTEGER) BETWEEN 1700 AND 2100
         THEN TRY_CAST(n.ACT_YR_BLT AS INTEGER) END                         AS built_year,
    CASE WHEN TRY_CAST(n.EFF_YR_BLT AS INTEGER) BETWEEN 1700 AND 2100
         THEN TRY_CAST(n.EFF_YR_BLT AS INTEGER) END                         AS effective_built_year,
    TRY_CAST(n.TOT_LVG_AREA AS DOUBLE)                                      AS livable_floor_area,
    TRY_CAST(n.NO_BULDNG AS INTEGER)                                        AS building_count,
    TRY_CAST(n.NO_RES_UNTS AS INTEGER)                                      AS residential_units,
    TRY_CAST(n.AV_NSD AS DOUBLE)                                            AS assessed_value,
    TRY_CAST(n.JV AS DOUBLE)                                                AS market_value,
    TRY_CAST(n.LND_VAL AS DOUBLE)                                           AS land_value,
    TRY_CAST(n.TV_NSD AS DOUBLE)                                            AS taxable_value,
    nullif(trim(n.OWN_NAME), '')                                            AS owner_name,
    nullif(trim(n.OWN_NAME), '')                                            AS owners_text,
    -- The roll packs co-owners into one name field: "TAYLOR JAMES THOMAS &
    -- ANGEL LE" is two people. Publishing 1 for every populated row made the
    -- tenant view headline "more than one owner: 0" while 86,697 parcels name
    -- two owners, and gave any consumer a column that never varies. Empty
    -- segments are dropped, because the roll also carries truncated names like
    -- "FRANKLIN ELIZABETH &" where the second owner did not survive export.
    CASE WHEN trim(coalesce(n.OWN_NAME,'')) = '' THEN 0
         ELSE greatest(
           1,
           len(list_filter(str_split(trim(n.OWN_NAME), '&'), x -> trim(x) <> ''))
         ) END                                                                  AS owner_count,
    nullif(trim(n.OWN_CITY), '')                                            AS owner_mailing_city,
    nullif(trim(n.OWN_STATE), '')                                           AS owner_mailing_state,
    nullif(trim(n.OWN_ZIPCD), '')                                           AS owner_mailing_zip,
    -- A city name alone does not place an owner in this county: Leesburg is in
    -- Virginia, Georgia and Illinois too, Grand Island is in New York, and
    -- Altoona is in Pennsylvania. Matching on the name alone recorded 29 owners
    -- as simultaneously out of state and in county, and quietly moved every one
    -- of them out of the out-of-area lead list they belong in. The state is
    -- checked first, so out-of-state now implies out-of-county by construction.
    CASE WHEN trim(coalesce(n.OWN_CITY,'')) = '' THEN NULL
         WHEN trim(coalesce(n.OWN_STATE,'')) <> ''
              AND upper(trim(n.OWN_STATE)) <> 'FL' THEN true
         ELSE upper(trim(n.OWN_CITY)) NOT IN (SELECT city FROM in_county_city) END
                                                                            AS owner_out_of_county,
    CASE WHEN trim(coalesce(n.OWN_STATE,'')) = '' THEN NULL
         ELSE upper(trim(n.OWN_STATE)) <> 'FL' END                          AS owner_out_of_state,
    CASE WHEN TRY_CAST(n.SALE_YR1 AS INTEGER) BETWEEN 1700 AND 2100
         THEN printf('%04d-%02d-01', TRY_CAST(n.SALE_YR1 AS INTEGER),
              coalesce(nullif(least(greatest(TRY_CAST(n.SALE_MO1 AS INTEGER),1),12),0),1)) END
                                                                            AS last_sale_date,
    TRY_CAST(n.SALE_PRC1 AS DOUBLE)                                         AS last_sale_price,
    CASE WHEN TRY_CAST(n.SALE_YR2 AS INTEGER) BETWEEN 1700 AND 2100
         THEN printf('%04d-%02d-01', TRY_CAST(n.SALE_YR2 AS INTEGER),
              coalesce(nullif(least(greatest(TRY_CAST(n.SALE_MO2 AS INTEGER),1),12),0),1)) END
                                                                            AS prior_sale_date,
    TRY_CAST(n.SALE_PRC2 AS DOUBLE)                                         AS prior_sale_price,
    CAST(coalesce(s.sale_records_in_window, 0) AS INTEGER)                  AS sale_records_in_window,
    (TRY_CAST(n.SALE_YR1 AS INTEGER) IS NULL AND coalesce(s.sale_records_in_window,0) = 0)
                                                                            AS no_recorded_sale_in_dor_window,
    roof.age_years                                                          AS roof_age_years,
    roof.basis                                                              AS roof_age_basis,
    roof.last_permit_date                                                   AS roof_last_permit_date,
    coalesce(p.permit_count, 0) > 0                                         AS has_permits,
    CAST(coalesce(p.permit_count, 0) AS INTEGER)                            AS permit_count,
    CAST(coalesce(p.roofing_permit_count, 0) AS INTEGER)                    AS roofing_permit_count,
    CAST(coalesce(p.open_permit_count, 0) AS INTEGER)                       AS open_permit_count,
    CAST(coalesce(p.open_roofing_permit_count, 0) AS INTEGER)               AS open_roofing_permit_count,
    CAST(p.longest_open_permit_days AS INTEGER)                             AS longest_open_permit_days,
    p.latest_permit_date                                                    AS latest_permit_date,
    ct.contractor_name                                                      AS contractor_name,
    CAST(NULL AS VARCHAR)                                                   AS bbb_rating,
    -- Null, not false, for the same reason as the two columns above: BBB is
    -- 403-gated and Sunbiz was never ingested, so `false` would assert an
    -- absence nobody checked. A consumer reading `has_bbb_contractor = false`
    -- would take it as an established negative.
    CAST(NULL AS BOOLEAN)                                                   AS has_bbb_contractor,
    CAST(NULL AS BOOLEAN)                                                   AS has_sunbiz_tenant,
    coalesce(t.business_account_count, 0) > 0                               AS has_business_account,
    CAST(coalesce(t.business_account_count, 0) AS INTEGER)                  AS business_account_count,
    t.business_naics_codes                                                 AS business_naics_codes,
    t.business_names                                                       AS business_names,
    CAST(coalesce(t.roofing_business_count, 0) AS INTEGER)                 AS roofing_business_count,
    concat_ws(';',
      CASE WHEN coalesce(p.permit_count,0) > 0 THEN 'permits_loaded'
           ELSE 'no_permits_in_source' END,
      -- Three distinct contractor states, because "null" alone cannot tell a
      -- reader whether nobody looked or nobody was found. Clermont is
      -- harvestable and harvested; the other fourteen jurisdictions are not.
      CASE WHEN ct.contractor_name IS NOT NULL THEN 'contractor_from_clermont_etrakit'
           WHEN coalesce(p.municipal_permit_count,0) > 0 THEN 'contractor_absent_on_permit'
           ELSE 'contractor_gated_403' END,
      'bbb_gated_403')                                                      AS enrichment_status,
    concat_ws('|', 'fl_dor_nal_2026p',
      CASE WHEN c.lat IS NOT NULL THEN 'fl_gio_parcel_centroid_2025' END,
      CASE WHEN coalesce(p.permit_count,0) - coalesce(p.municipal_permit_count,0) > 0
           THEN 'lake_cdplus_permits' END,
      CASE WHEN coalesce(p.municipal_permit_count,0) > 0
           THEN 'lake_clermont_etrakit_permits' END,
      CASE WHEN coalesce(s.sale_records_in_window,0) > 0 THEN 'fl_dor_sdf_2026p' END,
      CASE WHEN coalesce(t.business_account_count,0) > 0 THEN 'fl_dor_tpp_2026p' END)
                                                                            AS source_systems
  FROM nal n
  LEFT JOIN centroid  c ON c.alt_key = n.ALT_KEY
  LEFT JOIN permit_agg p ON p.alternate_key = n.ALT_KEY
  LEFT JOIN contractor_agg ct ON ct.alternate_key = n.ALT_KEY
  LEFT JOIN sale_agg   s ON s.PARCEL_ID = n.PARCEL_ID
  LEFT JOIN tpp_agg    t ON t.addr = upper(trim(n.PHY_ADDR1)) AND t.zip = trim(n.PHY_ZIPCD)
  LEFT JOIN LATERAL (
    SELECT CASE
             WHEN TRY_CAST(n.DOR_UC AS INTEGER) = 0 THEN 'vacant_residential'
             WHEN TRY_CAST(n.DOR_UC AS INTEGER) = 1 THEN 'single_family'
             WHEN TRY_CAST(n.DOR_UC AS INTEGER) = 2 THEN 'mobile_home'
             WHEN TRY_CAST(n.DOR_UC AS INTEGER) IN (3,8) THEN 'multi_family'
             WHEN TRY_CAST(n.DOR_UC AS INTEGER) = 4 THEN 'condo'
             WHEN TRY_CAST(n.DOR_UC AS INTEGER) BETWEEN 5 AND 9 THEN 'residential_other'
             WHEN TRY_CAST(n.DOR_UC AS INTEGER) BETWEEN 10 AND 39 THEN 'commercial'
             WHEN TRY_CAST(n.DOR_UC AS INTEGER) BETWEEN 40 AND 49 THEN 'industrial'
             WHEN TRY_CAST(n.DOR_UC AS INTEGER) BETWEEN 50 AND 69 THEN 'agricultural'
             WHEN TRY_CAST(n.DOR_UC AS INTEGER) BETWEEN 70 AND 79 THEN 'institutional'
             WHEN TRY_CAST(n.DOR_UC AS INTEGER) BETWEEN 80 AND 89 THEN 'government'
             ELSE 'other' END AS band
  ) use_band ON true
  LEFT JOIN LATERAL (
    SELECT
      CASE
        WHEN p.roof_co_date IS NOT NULL
          THEN CAST($AS_OF_YEAR - TRY_CAST(substr(p.roof_co_date,1,4) AS INTEGER) AS INTEGER)
        WHEN p.roof_issued_date IS NOT NULL
          THEN CAST($AS_OF_YEAR - TRY_CAST(substr(p.roof_issued_date,1,4) AS INTEGER) AS INTEGER)
        WHEN TRY_CAST(n.ACT_YR_BLT AS INTEGER) BETWEEN 1700 AND 2100
          THEN CAST($AS_OF_YEAR - TRY_CAST(n.ACT_YR_BLT AS INTEGER) AS INTEGER)
      END AS age_years,
      CASE
        WHEN p.roof_co_date IS NOT NULL THEN 'roofing_permit_completed'
        WHEN p.roof_issued_date IS NOT NULL THEN 'roofing_permit_issued'
        WHEN TRY_CAST(n.ACT_YR_BLT AS INTEGER) BETWEEN 1700 AND 2100 THEN 'year_built'
      END AS basis,
      coalesce(p.roof_co_date, p.roof_issued_date) AS last_permit_date
  ) roof ON true
) TO '$OUT_PARQUET' (FORMAT PARQUET, COMPRESSION ZSTD);
