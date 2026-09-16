/**
 * Contractor view: permit posture, and an unmissable statement of what is
 * missing.
 *
 * Contractor identity and BBB reputation are the two things a reader most
 * expects here, and for most of Lake County the sources will not serve them.
 * Rather than hiding the columns, the page leads with the gating notices and
 * then proves the claim with a live count: `contractor_names_present` and
 * `bbb_ratings_present` are queried out of the same table as everything else,
 * not asserted.
 *
 * The two counts no longer mean the same thing. `bbb_ratings_present` is zero
 * and stays zero. `contractor_names_present` counts the parcels Clermont's
 * eTRAKiT portal named a contractor on - one jurisdiction of fifteen - so its
 * tile carries that boundary beside the number. A count queried live is the
 * only way to keep this page honest in both directions: it cannot overstate
 * coverage the table does not have, and it cannot go on calling a column empty
 * once a jurisdiction starts publishing it.
 */

import { useMemo, useState } from "react";
import { PARTIALLY_POPULATED_COLUMNS, type SearchOptions } from "@oracle-lake/shared";
import { BarChart } from "../components/BarChart.js";
import { Pager } from "../components/Pager.js";
import { ErrorPanel, Panel, SkeletonRows, StatTile } from "../components/Primitives.js";
import { PropertyTable } from "../components/PropertyTable.js";
import { SqlBlock } from "../components/SqlBlock.js";
import { useDataSource } from "../data/DataSourceProvider.js";
import { useAsync } from "../hooks/useAsync.js";
import { navigate, propertyPath } from "../hooks/useHashRoute.js";
import { formatCount, formatDays, humanizeKey } from "../lib/format.js";

const POSTURE_TILES: readonly {
  key: string;
  label: string;
  note?: string;
  tone?: "accent" | "warn";
}[] = [
  { key: "properties_with_permits", label: "Parcels with permits", tone: "accent" },
  { key: "permit_records", label: "Total permit records" },
  { key: "permit_records_linked", label: "Permit records linked to parcels" },
  {
    key: "permit_records_valid_unlinked",
    label: "Valid unlinked permit records",
    note: "retained in the permit table, without a parcel link",
  },
  { key: "roofing_permit_records", label: "Linked roofing permit records" },
  { key: "open_permit_records", label: "Linked open permit records" },
  { key: "open_roofing_permit_records", label: "Linked open roofing permit records", tone: "warn" },
  { key: "properties_with_open_permit", label: "Parcels with an open permit" },
  { key: "properties_with_open_roofing_permit", label: "Parcels with open roofing", tone: "warn" },
];

const DURATION_BUCKETS: readonly { key: string; label: string }[] = [
  { key: "open_under_90_days", label: "under 90 days" },
  { key: "open_90_to_364_days", label: "90–364 days" },
  { key: "open_1_to_5_years", label: "1–5 years" },
  { key: "open_over_5_years", label: "over 5 years" },
];

export function ContractorView(): JSX.Element {
  const { source, meta } = useDataSource();
  const evidenceOnly = meta?.sourceObservationsOnly === true || meta?.localEvidencePreview === true;
  const view = useAsync(() => source.getContractorView(), [source]);
  const stats = useAsync(() => source.getStats(), [source]);
  const [offset, setOffset] = useState(0);

  const options = useMemo<SearchOptions>(
    () => ({
      hasOpenRoofingPermit: true,
      sortBy: "longest_open_roofing_permit_days",
      sortDir: "desc",
      limit: 50,
      offset,
    }),
    [offset],
  );

  const results = useAsync(
    () => (evidenceOnly ? Promise.resolve(null) : source.search(options)),
    [source, evidenceOnly, JSON.stringify(options)],
  );
  const historicalSql = `SELECT permit_number, jurisdiction, permit_status, issued_date, permit_description,
    contractor_name, parcel_identifier, linkage_status, source_url FROM permits
    ORDER BY permit_id LIMIT 50 OFFSET ${offset}`;
  const historical = useAsync(
    () => (evidenceOnly ? source.runSql(historicalSql, 50) : Promise.resolve(null)),
    [source, evidenceOnly, historicalSql],
  );

  const totalParcels = stats.data?.stats.properties;
  const contractorNames = view.data?.posture.contractor_names_present;
  const bbbRatings = view.data?.posture.bbb_ratings_present;
  const proofReady =
    typeof totalParcels === "number" &&
    typeof contractorNames === "number" &&
    typeof bbbRatings === "number";

  return (
    <div className="stack">
      <section className="panel" style={{ borderColor: "rgba(232,178,105,0.45)" }}>
        <header className="panel-head">
          <div className="panel-title">
            <h2>What this view cannot tell you, and why</h2>
            <span className="prose">
              <code>bbb_rating</code> is null on every row. <code>contractor_name</code> is null
              everywhere except Clermont, the one jurisdiction of fifteen whose permit portal
              publishes a contractor of record. Both columns are published anyway, because a missing
              column and an empty column say different things.
            </span>
          </div>
        </header>

        {view.error ? <ErrorPanel error={view.error} onRetry={view.reload} /> : null}
        {view.loading && !view.data ? <SkeletonRows rows={3} height={40} /> : null}

        <div className="stack-sm">
          {(view.data?.gating ?? []).map((notice) => (
            <div className="notice gated" key={notice.token}>
              <h3>{notice.headline}</h3>
              <p>{notice.detail}</p>
              {notice.field ? (
                <span className="micro">
                  column {notice.field} ·{" "}
                  {notice.field in PARTIALLY_POPULATED_COLUMNS
                    ? "null outside Clermont"
                    : "stays null"}
                </span>
              ) : null}
            </div>
          ))}
        </div>

        <div className="tile-grid" style={{ marginTop: 14 }}>
          <StatTile
            label="contractor_names_present"
            loading={!proofReady && (view.loading || stats.loading)}
            value={typeof contractorNames === "number" ? formatCount(contractorNames) : "—"}
            note={
              proofReady
                ? `Clermont only (1 of 15 jurisdictions) · out of ${formatCount(totalParcels)} parcels · queried, not asserted`
                : undefined
            }
            tone="warn"
          />
          <StatTile
            label="bbb_ratings_present"
            loading={!proofReady && (view.loading || stats.loading)}
            value={typeof bbbRatings === "number" ? formatCount(bbbRatings) : "—"}
            note={
              proofReady
                ? `out of ${formatCount(totalParcels)} parcels · queried, not asserted`
                : undefined
            }
            tone="warn"
          />
        </div>

        {view.data ? (
          <p className="prose" style={{ marginTop: 12 }}>
            {view.data.note}
          </p>
        ) : null}
        {view.data ? (
          <div style={{ marginTop: 12 }}>
            <SqlBlock provenance={view.data.provenance} label="SQL behind these two counts" />
          </div>
        ) : null}
      </section>

      <Panel
        title="Permit posture"
        subtitle="Aggregated from the Lake County CD Plus permit layer and Clermont eTRAKiT evidence."
      >
        <div className="tile-grid">
          {POSTURE_TILES.map((tile) => (
            <StatTile
              key={tile.key}
              label={
                tile.key === "permit_records" &&
                typeof view.data?.posture.permit_records_total !== "number"
                  ? "Linked permit records (legacy aggregate)"
                  : tile.label
              }
              note={
                tile.key === "permit_records" &&
                typeof view.data?.posture.permit_records_total !== "number"
                  ? "property aggregate only; total and unlinked counts unavailable"
                  : tile.note
              }
              loading={view.loading && !view.data}
              value={
                typeof view.data?.posture[tile.key] === "number"
                  ? formatCount(view.data.posture[tile.key])
                  : "—"
              }
              tone={tile.tone ?? "neutral"}
            />
          ))}
          <StatTile
            label="Longest open permit (any type)"
            loading={view.loading && !view.data}
            value={formatDays(view.data?.posture.longest_open_permit_days)}
          />
          <StatTile
            label="Longest open roofing permit"
            loading={view.loading && !view.data}
            value={formatDays(view.data?.posture.longest_open_roofing_permit_days)}
            tone="warn"
          />
        </div>
      </Panel>

      <Panel
        title="How long open permits of any type have been open"
        subtitle="Generic permit posture, bucketed from longest_open_permit_days on each parcel."
      >
        {view.loading && !view.data ? (
          <SkeletonRows rows={4} height={18} />
        ) : (
          <BarChart
            ariaLabel="Parcels by how long their longest open permit of any type has been open"
            emptyText="No usable open-duration observations; this is not proof that no open permits exist."
            data={DURATION_BUCKETS.filter(
              (bucket) => typeof view.data?.posture[bucket.key] === "number",
            ).map((bucket) => ({
              label: bucket.label,
              value: view.data?.posture[bucket.key] ?? 0,
            }))}
          />
        )}
        {view.data ? (
          <div className="kv-list" style={{ marginTop: 12 }}>
            {DURATION_BUCKETS.map((bucket) => (
              <div className="kv" key={bucket.key}>
                <span>{humanizeKey(bucket.key)}</span>
                <span>{formatCount(view.data?.posture[bucket.key])}</span>
              </div>
            ))}
          </div>
        ) : null}
      </Panel>

      <Panel
        title={
          evidenceOnly
            ? "Retained historical permit observations"
            : "Parcels with an open roofing permit"
        }
        subtitle={
          evidenceOnly
            ? "All sources, including valid unlinked records. Status is retained source text, not current; names are source-listed, not verified legal identities."
            : "Ordered by the longest open roofing permit duration, descending."
        }
      >
        {evidenceOnly ? (
          <>
            <p className="notice gated">
              Current-open roofing status and duration are unknown in this selected dataset.
              Historical source observations below are not proof of completion, current status, or a
              verified license. Building-year roof proxies remain available in property search.
            </p>
            {historical.error ? (
              <ErrorPanel error={historical.error} onRetry={historical.reload} />
            ) : null}
            {historical.loading && !historical.data ? <SkeletonRows rows={5} height={24} /> : null}
            {historical.data ? (
              <>
                <div className="table-scroll">
                  <table className="data" style={{ minWidth: 900 }}>
                    <thead>
                      <tr>
                        <th>Permit / jurisdiction</th>
                        <th>Historical status / source issue date</th>
                        <th>Source work text</th>
                        <th>Source-listed name</th>
                        <th>Property link</th>
                        <th>Source</th>
                      </tr>
                    </thead>
                    <tbody>
                      {historical.data.rows.map((row, index) => (
                        <tr key={`${String(row.permit_number)}:${index}`}>
                          <td>
                            {String(row.permit_number ?? "—")}
                            <br />
                            {String(row.jurisdiction ?? "—")}
                          </td>
                          <td>
                            {String(row.permit_status ?? "unknown")}
                            <br />
                            {String(row.issued_date ?? "unknown")}
                          </td>
                          <td>{String(row.permit_description ?? "—")}</td>
                          <td>{String(row.contractor_name ?? "not captured; absence unproven")}</td>
                          <td>
                            {row.parcel_identifier &&
                            row.linkage_status === "linked_to_assessed_roll" ? (
                              <button
                                type="button"
                                className="btn small"
                                onClick={() =>
                                  navigate(propertyPath(String(row.parcel_identifier)))
                                }
                              >
                                {String(row.parcel_identifier)}
                              </button>
                            ) : (
                              `valid unlinked${row.parcel_identifier ? `: ${String(row.parcel_identifier)}` : ""}`
                            )}
                          </td>
                          <td>
                            {typeof row.source_url === "string" &&
                            row.source_url.startsWith("https://") ? (
                              <a href={row.source_url} target="_blank" rel="noreferrer">
                                Source
                              </a>
                            ) : (
                              "—"
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {typeof stats.data?.stats.permit_records_total === "number" ? (
                  <Pager
                    offset={offset}
                    limit={50}
                    matched={stats.data.stats.permit_records_total}
                    returned={historical.data.rows.length}
                    onOffset={setOffset}
                    busy={historical.loading}
                    noun="permits"
                  />
                ) : (
                  <p>
                    Total retained permit count is still loading or unavailable; this does not
                    establish zero.
                  </p>
                )}
                <SqlBlock provenance={historical.data.provenance} />
              </>
            ) : null}
          </>
        ) : (
          <>
            {results.error ? <ErrorPanel error={results.error} onRetry={results.reload} /> : null}
            <PropertyTable
              rows={results.data?.rows ?? []}
              loading={results.loading}
              onOpen={(parcelId) => navigate(propertyPath(parcelId))}
              emptyText={
                results.error
                  ? "Current-open results are unavailable; this is not proof of no open permits."
                  : "No parcel in the selected decision-enabled table matches this open-roofing query."
              }
            />
            {results.data ? (
              <>
                <Pager
                  offset={results.data.offset}
                  limit={results.data.limit}
                  matched={results.data.matched}
                  returned={results.data.rows.length}
                  onOffset={setOffset}
                  busy={results.loading}
                />
                <div style={{ marginTop: 12 }}>
                  <SqlBlock provenance={results.data.provenance} />
                </div>
              </>
            ) : null}
          </>
        )}
      </Panel>
    </div>
  );
}
