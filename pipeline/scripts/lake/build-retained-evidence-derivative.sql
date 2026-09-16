-- Retrospective, private observation derivative, NOT the certified capture schema.
-- Prepared under county-query-table-publish's local export/validation neighbour.
-- No permit-backed primary-roof anchor or current/open decision is accepted.
-- Parameters are SQL-escaped local paths supplied by the TypeScript driver.

CREATE VIEW previous_properties AS SELECT * FROM read_parquet($PROPERTY_INPUT);
CREATE VIEW raw_built_years AS
SELECT PARCEL_ID, ACT_YR_BLT, EFF_YR_BLT
FROM read_csv_auto($NAL_INPUT, header=true, all_varchar=true);
CREATE VIEW repaired_permits AS
SELECT * REPLACE (
  CAST(is_open AS BOOLEAN) AS is_open,
  CAST(is_roofing AS BOOLEAN) AS is_roofing,
  CAST(days_open AS INTEGER) AS days_open,
  CAST(completed_date AS VARCHAR) AS completed_date,
  CAST(contractor_license AS VARCHAR) AS contractor_license,
  CAST(bbb_rating AS VARCHAR) AS bbb_rating,
  CAST(current_permit_status AS VARCHAR) AS current_permit_status,
  CAST(contractor_company_id AS VARCHAR) AS contractor_company_id,
  CAST(accepted_primary_roof_work_class AS VARCHAR) AS accepted_primary_roof_work_class,
  CAST(accepted_roof_anchor_date AS VARCHAR) AS accepted_roof_anchor_date,
  CAST(permit_printed_license AS VARCHAR) AS permit_printed_license
)
FROM read_json_auto($EVIDENCE_INPUT, format='newline_delimited');

COPY (SELECT * FROM repaired_permits ORDER BY permit_id)
TO $PERMIT_OUTPUT (FORMAT PARQUET, COMPRESSION ZSTD);

COPY (
  WITH validated AS (
    SELECT p.*, n.ACT_YR_BLT AS raw_built_year, n.EFF_YR_BLT AS raw_effective_built_year,
      CASE WHEN regexp_full_match(n.ACT_YR_BLT, '[0-9]{4}')
                 AND TRY_CAST(n.ACT_YR_BLT AS INTEGER) BETWEEN 1700 AND $AS_OF_YEAR
           THEN CAST(n.ACT_YR_BLT AS INTEGER) END AS usable_built_year,
      CASE WHEN regexp_full_match(n.EFF_YR_BLT, '[0-9]{4}')
                 AND TRY_CAST(n.EFF_YR_BLT AS INTEGER) BETWEEN 1700 AND $AS_OF_YEAR
           THEN CAST(n.EFF_YR_BLT AS INTEGER) END AS usable_effective_built_year
    FROM previous_properties p
    LEFT JOIN raw_built_years n ON n.PARCEL_ID = p.request_identifier
  )
  SELECT * EXCLUDE (usable_built_year, usable_effective_built_year, raw_built_year, raw_effective_built_year) REPLACE (
    usable_built_year AS built_year,
    usable_effective_built_year AS effective_built_year,
    CAST($AS_OF_YEAR - usable_built_year AS INTEGER) AS roof_age_years,
    CASE WHEN usable_built_year IS NOT NULL THEN 'built_year_proxy' END AS roof_age_basis,
    CAST(NULL AS VARCHAR) AS roof_last_permit_date,
    CAST(NULL AS INTEGER) AS roofing_permit_count,
    CAST(NULL AS INTEGER) AS open_permit_count,
    CAST(NULL AS INTEGER) AS open_roofing_permit_count,
    CAST(NULL AS INTEGER) AS longest_open_permit_days,
    CAST(NULL AS INTEGER) AS longest_open_roofing_permit_days,
    concat_ws(';', 'retained_source_observations',
      'current_permit_status_not_revalidated', 'primary_roof_completion_needs_review',
      'contractor_source_name_only', 'contractor_absence_not_proven',
      'sunbiz_temporal_dbpr_required', 'bbb_policy_api_gated') AS enrichment_status
  ),
  raw_built_year AS source_observed_built_year,
  raw_effective_built_year AS source_observed_effective_built_year,
  roof_age_years AS previous_unaccepted_roof_age_years,
  roof_age_basis AS previous_unaccepted_roof_age_basis,
  roof_last_permit_date AS previous_unaccepted_roof_anchor_date,
  roofing_permit_count AS roofing_discovery_permit_count,
  open_permit_count AS source_export_open_permit_count,
  open_roofing_permit_count AS source_export_open_roofing_permit_count,
  longest_open_permit_days AS source_export_longest_open_permit_days,
  longest_open_roofing_permit_days AS source_export_longest_open_roofing_permit_days,
  CASE WHEN usable_built_year IS NOT NULL THEN 'low' END AS roof_age_confidence,
  CASE WHEN usable_built_year IS NOT NULL THEN 'confirmed_present'
       WHEN nullif(trim(raw_built_year), '') IS NULL THEN 'unknown'
       ELSE 'invalid_quarantined' END AS built_year_evidence_state,
  CASE WHEN usable_effective_built_year IS NOT NULL THEN 'confirmed_present'
       WHEN nullif(trim(raw_effective_built_year), '') IS NULL THEN 'unknown'
       ELSE 'invalid_quarantined' END AS effective_built_year_evidence_state,
  CASE WHEN usable_built_year IS NOT NULL THEN 'eligible_proxy' ELSE 'needs_review' END AS roof_age_decision,
  'Partial county/municipal/predecessor permit history; accepted replacement semantics are unproven; an unobserved later replacement may exist. Built year is not measured roof age.' AS roof_age_caveat,
  'source_display_name_only; not a verified legal company identity' AS contractor_attribution_kind,
  CAST(NULL AS VARCHAR) AS contractor_company_id,
  CAST(NULL AS INTEGER) AS accepted_primary_roof_permit_count,
  'oracle.lake-retained-evidence.v1' AS evidence_contract_version
  FROM validated
  ORDER BY request_identifier
) TO $PROPERTY_OUTPUT (FORMAT PARQUET, COMPRESSION ZSTD);
