/**
 * Property detail: all 62 published columns for one parcel, grouped.
 *
 * The point of this page is that nothing is hidden. Every published column is
 * rendered, including the ones that are always null, and a null never appears
 * as an empty cell: it appears as a dash plus the reason, taken from the row's
 * own `enrichment_status` or, failing that, from `ALWAYS_NULL_COLUMNS` and
 * `PARTIALLY_POPULATED_COLUMNS`. Any column the pipeline adds later that is
 * not in a group below still shows up, under "Other published columns", so the
 * page cannot silently drop a field.
 *
 * `contractor_name` is why the reason is looked up in that order. It is
 * published for Clermont parcels and null for the rest of the county, so the
 * same column needs three different explanations depending on the row, and
 * only the row knows which one applies.
 */

import {
  ALWAYS_NULL_COLUMNS,
  getColumn,
  PARTIALLY_POPULATED_COLUMNS,
  parseEnrichmentStatus,
  parseSourceSystems,
  QUERY_TABLE_COLUMN_NAMES,
  ROOF_AGE_BASIS_LABELS,
  TENURE_CAVEAT,
} from "@oracle-lake/shared";
import { Badge, ErrorPanel, Panel, SkeletonRows } from "../components/Primitives.js";
import { SqlBlock } from "../components/SqlBlock.js";
import { useDataSource } from "../data/DataSourceProvider.js";
import { useAsync } from "../hooks/useAsync.js";
import { navigate } from "../hooks/useHashRoute.js";
import {
  formatCount,
  formatCurrency,
  formatDate,
  formatDays,
  formatNumber,
} from "../lib/format.js";

const GROUPS: readonly { title: string; columns: readonly string[] }[] = [
  {
    title: "Identity",
    columns: [
      "property_id",
      "property_cid",
      "request_identifier",
      "parcel_identifier",
      "alt_key",
      "source_system",
      "county_name",
      "state_code",
    ],
  },
  {
    title: "Location",
    columns: [
      "address_street",
      "address_city",
      "address_zip",
      "latitude",
      "longitude",
      "lot_area_sqft",
      "lot_size_acre",
    ],
  },
  {
    title: "Structure",
    columns: [
      "property_type",
      "property_usage_type",
      "dor_use_code",
      "built_year",
      "effective_built_year",
      "livable_floor_area",
      "building_count",
      "residential_units",
    ],
  },
  { title: "Value", columns: ["assessed_value", "market_value", "land_value", "taxable_value"] },
  {
    title: "Ownership & tenure",
    columns: [
      "owner_name",
      "owners_text",
      "owner_count",
      "owner_mailing_city",
      "owner_mailing_state",
      "owner_mailing_zip",
      "owner_out_of_county",
      "owner_out_of_state",
      "last_sale_date",
      "last_sale_price",
      "prior_sale_date",
      "prior_sale_price",
      "sale_records_in_window",
      "no_recorded_sale_in_dor_window",
    ],
  },
  { title: "Roof", columns: ["roof_age_years", "roof_age_basis", "roof_last_permit_date"] },
  {
    title: "Permits",
    columns: [
      "has_permits",
      "permit_count",
      "roofing_permit_count",
      "open_permit_count",
      "open_roofing_permit_count",
      "longest_open_permit_days",
      "latest_permit_date",
      "contractor_name",
      "bbb_rating",
      "has_bbb_contractor",
    ],
  },
  {
    title: "Business",
    columns: ["has_sunbiz_tenant", "has_business_account", "business_account_count"],
  },
  { title: "Provenance", columns: ["enrichment_status", "source_systems"] },
];

/** Years are printed bare: thousands separators make a year look like a count. */
const YEAR_COLUMNS = new Set(["built_year", "effective_built_year"]);

const CURRENCY_COLUMNS = new Set([
  "assessed_value",
  "market_value",
  "land_value",
  "taxable_value",
  "last_sale_price",
  "prior_sale_price",
]);

const DATE_COLUMNS = new Set([
  "last_sale_date",
  "prior_sale_date",
  "roof_last_permit_date",
  "latest_permit_date",
]);

const GROUPED = new Set(GROUPS.flatMap((group) => group.columns));
const UNGROUPED = QUERY_TABLE_COLUMN_NAMES.filter((name) => !GROUPED.has(name));

/** Render one published cell, or the reason it is null. */
function renderValue(column: string, value: unknown): { text: string; isNull: boolean } {
  if (value === null || value === undefined || value === "") return { text: "—", isNull: true };
  if (typeof value === "boolean") return { text: value ? "true" : "false", isNull: false };
  if (typeof value === "number") {
    if (CURRENCY_COLUMNS.has(column)) return { text: formatCurrency(value), isNull: false };
    if (column === "longest_open_permit_days") return { text: formatDays(value), isNull: false };
    if (column === "latitude" || column === "longitude") {
      return { text: value.toFixed(6), isNull: false };
    }
    // A year is an identifier, not a quantity: grouping made 2021 read "2,021".
    if (YEAR_COLUMNS.has(column)) return { text: String(value), isNull: false };
    if (Number.isInteger(value)) return { text: formatCount(value), isNull: false };
    return { text: formatNumber(value), isNull: false };
  }
  if (typeof value === "string") {
    if (DATE_COLUMNS.has(column)) return { text: formatDate(value), isNull: false };
    if (column === "roof_age_basis") {
      return { text: ROOF_AGE_BASIS_LABELS[value] ?? value, isNull: false };
    }
    return { text: value, isNull: false };
  }
  return { text: String(value), isNull: false };
}

export function PropertyView({ parcelId }: { parcelId: string }): JSX.Element {
  const { source } = useDataSource();
  const detail = useAsync(() => source.getProperty(parcelId), [source, parcelId]);

  if (detail.loading && !detail.data) {
    return (
      <Panel title={`Parcel ${parcelId}`}>
        <SkeletonRows rows={10} height={18} />
      </Panel>
    );
  }

  if (detail.error) {
    return (
      <div className="stack">
        <ErrorPanel error={detail.error} onRetry={detail.reload} />
        <button type="button" className="btn" onClick={() => navigate("/search")}>
          ← Back to search
        </button>
      </div>
    );
  }

  const data = detail.data;
  if (!data) return <Panel title={`Parcel ${parcelId}`}>No data returned.</Panel>;

  const property = data.property;
  const enrichment =
    typeof property.enrichment_status === "string" ? property.enrichment_status : null;
  const rowNotices = parseEnrichmentStatus(enrichment);
  const sources = parseSourceSystems(
    typeof property.source_systems === "string" ? property.source_systems : null,
  );

  /**
   * The explanation for a null in this column, if the pipeline has one.
   *
   * The row wins over the column-level defaults, because only the row can say
   * whether this parcel's blank `contractor_name` is gated or an absence the
   * source established. Severity "present" notices are skipped: a row carrying
   * `contractor_from_clermont_etrakit` has a contractor, and that notice
   * explains a value rather than a blank. It is never reached for a populated
   * cell anyway - `DetailRow` renders the reason only when the value is null -
   * but a "reason" that explains a value would be the wrong string to hold.
   */
  const reasonFor = (column: string): string | null => {
    const fromRow = rowNotices.find(
      (notice) => notice.field === column && notice.severity !== "present",
    );
    if (fromRow) return fromRow.detail;
    return ALWAYS_NULL_COLUMNS[column] ?? PARTIALLY_POPULATED_COLUMNS[column] ?? null;
  };

  return (
    <div className="stack">
      <Panel
        title={
          typeof property.address_street === "string"
            ? property.address_street
            : `Parcel ${parcelId}`
        }
        subtitle={
          <span className="mono">
            {typeof property.request_identifier === "string"
              ? property.request_identifier
              : parcelId}
          </span>
        }
        actions={
          <button type="button" className="btn small ghost" onClick={() => navigate("/search")}>
            ← Back to search
          </button>
        }
      >
        <div className="chip-row">
          {sources.length === 0 ? (
            <span className="dim">No source systems recorded on this row.</span>
          ) : (
            sources.map((entry) => (
              <Badge key={entry.token} tone="accent" title={entry.token}>
                {entry.label}
              </Badge>
            ))
          )}
        </div>
        {data.gating.length > 0 ? (
          <div className="stack-sm" style={{ marginTop: 12 }}>
            {data.gating.map((notice) => (
              // The browser data path decodes every token, not only the gated
              // ones, so severity picks the styling: a Clermont row's
              // "Contractor of record published" notice names a column and
              // would otherwise be painted as a warning about a missing value.
              <div
                key={notice.token}
                className={`notice ${notice.severity === "gated" ? "gated" : "info"}`}
              >
                <h3>{notice.headline}</h3>
                <p>{notice.detail}</p>
                {notice.field ? (
                  <span className="micro">
                    {notice.severity === "present" ? "explains column" : "affects column"}{" "}
                    {notice.field}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </Panel>

      {GROUPS.map((group) => (
        <Panel key={group.title} title={group.title}>
          <div className="detail-grid">
            {group.columns.map((column) => (
              <DetailRow
                key={column}
                column={column}
                value={property[column]}
                reason={reasonFor(column)}
              />
            ))}
          </div>
          {group.title === "Ownership & tenure" ? (
            <div className="notice" style={{ marginTop: 12 }}>
              <span className="micro">about “no recorded sale in DOR window”</span>
              <p style={{ marginTop: 6 }}>{TENURE_CAVEAT}</p>
            </div>
          ) : null}
        </Panel>
      ))}

      {UNGROUPED.length > 0 ? (
        <Panel
          title="Other published columns"
          subtitle="Columns present in the published schema that this page has not been given a group for."
        >
          <div className="detail-grid">
            {UNGROUPED.map((column) => (
              <DetailRow
                key={column}
                column={column}
                value={property[column]}
                reason={reasonFor(column)}
              />
            ))}
          </div>
        </Panel>
      ) : null}

      <SqlBlock provenance={data.provenance} />
    </div>
  );
}

/** One published column: label, value or dash, and the reason for a null. */
function DetailRow({
  column,
  value,
  reason,
}: {
  column: string;
  value: unknown;
  reason: string | null;
}): JSX.Element {
  const meta = getColumn(column);
  const rendered = renderValue(column, value);
  return (
    <div className="detail-row">
      <span className="detail-key">{column}</span>
      <span className={`detail-value ${rendered.isNull ? "null" : ""}`}>{rendered.text}</span>
      {rendered.isNull && reason ? <span className="detail-reason">{reason}</span> : null}
      {meta ? (
        <span className="micro" style={{ marginTop: 2 }}>
          {meta.label} · {meta.source}
        </span>
      ) : null}
    </div>
  );
}
