/**
 * The shared results table for any list of parcels.
 *
 * Column headers that map to a published column are sort buttons; clicking one
 * sets `sortBy`/`sortDir`, which the shared SQL builder turns into an ORDER BY.
 * Roof age always shows its basis, and out-of-area ownership shows a worded
 * badge rather than a bare colour, so the table reads the same in greyscale.
 */

import { ROOF_AGE_BASIS_LABELS } from "@oracle-lake/shared";
import { formatCount, formatCurrency, formatNumber } from "../lib/format.js";
import { bool, num, parcelIdOf, str } from "../lib/rows.js";
import { Badge, EmptyState, SkeletonRows } from "./Primitives.js";

export interface SortState {
  sortBy?: string;
  sortDir?: "asc" | "desc";
}

interface Column {
  key: string;
  label: string;
  /** Published column to sort by; omitted when the column is not sortable. */
  sortColumn?: string;
  numeric?: boolean;
}

const COLUMNS: readonly Column[] = [
  { key: "parcel", label: "Parcel id", sortColumn: "request_identifier" },
  { key: "address", label: "Address", sortColumn: "address_street" },
  { key: "city", label: "City", sortColumn: "address_city" },
  { key: "roof", label: "Roof age", sortColumn: "roof_age_years", numeric: true },
  { key: "permits", label: "Permits", sortColumn: "permit_count", numeric: true },
  {
    key: "openRoof",
    label: "Open roofing",
    sortColumn: "open_roofing_permit_count",
    numeric: true,
  },
  { key: "owner", label: "Owner", sortColumn: "owner_name" },
  { key: "value", label: "Market value", sortColumn: "market_value", numeric: true },
];

function basisLabel(basis: string | null): string | null {
  if (!basis) return null;
  return ROOF_AGE_BASIS_LABELS[basis] ?? basis;
}

export function PropertyTable({
  rows,
  loading,
  sort,
  onSort,
  onOpen,
  showDistance = false,
  emptyText = "No parcels match these filters.",
}: {
  rows: readonly Record<string, unknown>[];
  loading: boolean;
  sort?: SortState;
  onSort?: (column: string) => void;
  onOpen: (parcelId: string) => void;
  showDistance?: boolean;
  emptyText?: string;
}): JSX.Element {
  if (loading && rows.length === 0) {
    return (
      <div className="table-scroll" style={{ padding: 12 }}>
        <SkeletonRows rows={8} height={18} />
      </div>
    );
  }
  if (!loading && rows.length === 0) return <EmptyState>{emptyText}</EmptyState>;

  const columns = showDistance
    ? [...COLUMNS, { key: "distance", label: "Distance", numeric: true } satisfies Column]
    : COLUMNS;

  return (
    <div className="table-scroll">
      <table className="data">
        <thead>
          <tr>
            {columns.map((column) => {
              const sortColumn = column.sortColumn;
              const isSorted = Boolean(sort?.sortBy) && sortColumn === sort?.sortBy;
              return (
                <th key={column.key} className={column.numeric ? "num" : undefined} scope="col">
                  {sortColumn && onSort ? (
                    <button
                      type="button"
                      onClick={() => onSort(sortColumn)}
                      aria-label={`Sort by ${column.label}`}
                    >
                      {column.label}
                      {isSorted ? (
                        <span className="sort-caret" aria-hidden="true">
                          {sort?.sortDir === "asc" ? "▲" : "▼"}
                        </span>
                      ) : null}
                    </button>
                  ) : (
                    column.label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const parcelId = parcelIdOf(row);
            const roofAge = num(row, "roof_age_years");
            const basis = basisLabel(str(row, "roof_age_basis"));
            const outOfState = bool(row, "owner_out_of_state") === true;
            const outOfCounty = bool(row, "owner_out_of_county") === true;
            const openRoofing = num(row, "open_roofing_permit_count") ?? 0;
            const longestOpen = num(row, "longest_open_permit_days");
            return (
              <tr
                key={parcelId ?? index}
                className={parcelId ? "clickable" : undefined}
                onClick={parcelId ? () => onOpen(parcelId) : undefined}
              >
                <td className="mono">
                  {parcelId ? (
                    <button
                      type="button"
                      className="parcel-chip"
                      onClick={(event) => {
                        event.stopPropagation();
                        onOpen(parcelId);
                      }}
                    >
                      {parcelId}
                    </button>
                  ) : (
                    "—"
                  )}
                </td>
                <td>{str(row, "address_street") ?? "—"}</td>
                <td>
                  {str(row, "address_city") ?? "—"}
                  {str(row, "address_zip") ? (
                    <span className="dim mono"> {str(row, "address_zip")}</span>
                  ) : null}
                </td>
                <td className="num">
                  {roofAge === null ? (
                    <span className="dim">unknown</span>
                  ) : (
                    <span>
                      {formatCount(roofAge)} yr
                      {basis ? (
                        <>
                          {" "}
                          <Badge tone="neutral" title={basis}>
                            {basis}
                          </Badge>
                        </>
                      ) : null}
                    </span>
                  )}
                </td>
                <td className="num">{formatCount(num(row, "permit_count") ?? 0)}</td>
                <td className="num">
                  {openRoofing > 0 ? (
                    <Badge
                      tone="warn"
                      title={longestOpen ? `Longest open ${longestOpen} days` : undefined}
                    >
                      {formatCount(openRoofing)} open
                    </Badge>
                  ) : (
                    <span className="dim">0</span>
                  )}
                </td>
                <td>
                  <div className="stack-sm">
                    <span>{str(row, "owner_name") ?? "—"}</span>
                    <div className="chip-row">
                      {outOfState ? <Badge tone="bad">Owner out of state</Badge> : null}
                      {!outOfState && outOfCounty ? (
                        <Badge tone="warn">Owner out of county</Badge>
                      ) : null}
                      {bool(row, "no_recorded_sale_in_dor_window") === true ? (
                        <Badge tone="neutral">No sale in DOR window</Badge>
                      ) : null}
                      {(num(row, "business_account_count") ?? 0) > 0 ? (
                        <Badge tone="accent">
                          {formatCount(num(row, "business_account_count"))} TPP account(s)
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                </td>
                <td className="num">{formatCurrency(num(row, "market_value"))}</td>
                {showDistance ? (
                  <td className="num">
                    {num(row, "distance_miles") === null
                      ? "—"
                      : `${formatNumber(num(row, "distance_miles"))} mi`}
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
