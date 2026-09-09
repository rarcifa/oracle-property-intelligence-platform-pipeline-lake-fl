/**
 * Business view: the DOR tangible-personal-property signal.
 *
 * A TPP account means a business reports taxable equipment at that situs
 * address. That is evidence of business activity at a parcel; it is not a
 * business directory, and the view says so in the server's own words before it
 * shows a single number.
 */

import { useMemo, useState } from "react";
import type { SearchOptions } from "@oracle-lake/shared";
import { BarChart } from "../components/BarChart.js";
import { Pager } from "../components/Pager.js";
import { ErrorPanel, Panel, SkeletonRows, StatTile } from "../components/Primitives.js";
import { PropertyTable } from "../components/PropertyTable.js";
import { SqlBlock } from "../components/SqlBlock.js";
import { useDataSource } from "../data/DataSourceProvider.js";
import { useAsync } from "../hooks/useAsync.js";
import { navigate, propertyPath } from "../hooks/useHashRoute.js";
import { formatCount, humanizeKey } from "../lib/format.js";

const TOTAL_KEYS = ["properties", "with_business_account", "business_accounts"] as const;

export function BusinessView(): JSX.Element {
  const { source } = useDataSource();
  const view = useAsync(() => source.getBusinessView(), [source]);
  const [offset, setOffset] = useState(0);

  const options = useMemo<SearchOptions>(
    () => ({
      hasBusinessAccount: true,
      sortBy: "business_account_count",
      sortDir: "desc",
      limit: 50,
      offset,
    }),
    [offset],
  );

  const results = useAsync(() => source.search(options), [source, JSON.stringify(options)]);

  return (
    <div className="stack">
      <div className="notice info">
        <span className="micro">what this signal is, and is not</span>
        {view.data ? (
          <p style={{ marginTop: 6, color: "var(--text)" }}>{view.data.note}</p>
        ) : (
          <SkeletonRows rows={2} />
        )}
      </div>

      <Panel title="Totals">
        {view.error ? <ErrorPanel error={view.error} onRetry={view.reload} /> : null}
        <div className="tile-grid">
          {TOTAL_KEYS.map((key) => (
            <StatTile
              key={key}
              label={humanizeKey(key)}
              loading={view.loading && !view.data}
              value={
                typeof view.data?.totals[key] === "number"
                  ? formatCount(view.data.totals[key])
                  : "—"
              }
              tone={key === "business_accounts" ? "accent" : "neutral"}
            />
          ))}
        </div>
        {view.data ? (
          <div style={{ marginTop: 14 }}>
            <SqlBlock provenance={view.data.provenance} />
          </div>
        ) : null}
      </Panel>

      <div className="grid-2">
        <Panel title="TPP accounts by city">
          {view.loading && !view.data ? (
            <SkeletonRows rows={8} height={18} />
          ) : (
            <BarChart
              ariaLabel="Tangible personal property accounts by city"
              emptyText="No city in the published roll carries a TPP account."
              data={(view.data?.byCity ?? []).slice(0, 20).map((entry) => ({
                label: entry.city,
                value: entry.business_accounts,
              }))}
            />
          )}
        </Panel>

        <Panel title="TPP accounts by property type">
          {view.loading && !view.data ? (
            <SkeletonRows rows={8} height={18} />
          ) : (
            <BarChart
              ariaLabel="Tangible personal property accounts by property type"
              emptyText="No property type in the published roll carries a TPP account."
              data={(view.data?.byType ?? []).slice(0, 20).map((entry) => ({
                label: entry.property_type,
                value: entry.business_accounts,
              }))}
            />
          )}
        </Panel>
      </div>

      <Panel
        title="Parcels with a business account"
        subtitle="Ordered by the number of TPP accounts reported at the situs address."
      >
        {results.error ? <ErrorPanel error={results.error} onRetry={results.reload} /> : null}
        <PropertyTable
          rows={results.data?.rows ?? []}
          loading={results.loading}
          onOpen={(parcelId) => navigate(propertyPath(parcelId))}
          emptyText="No parcel in the published table carries a TPP account."
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
      </Panel>
    </div>
  );
}
