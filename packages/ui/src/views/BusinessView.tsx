/**
 * Business view: the DOR tangible-personal-property signal.
 *
 * A TPP account means a business reports taxable equipment at that situs
 * address. That is evidence of business activity at a parcel; it is not a
 * business directory, and the view says so in the server's own words before it
 * shows a single number.
 */

import { useMemo, useState } from "react";
import { buildBusinessSearchSql, type SearchOptions } from "@oracle-lake/shared";
import { BarChart } from "../components/BarChart.js";
import { Pager } from "../components/Pager.js";
import { ErrorPanel, Panel, SkeletonRows, StatTile } from "../components/Primitives.js";
import { PropertyTable } from "../components/PropertyTable.js";
import { SqlBlock } from "../components/SqlBlock.js";
import { useDataSource } from "../data/DataSourceProvider.js";
import { useAsync } from "../hooks/useAsync.js";
import { navigate, propertyPath } from "../hooks/useHashRoute.js";
import { formatCount } from "../lib/format.js";

const TOTAL_TILES = [
  ["properties", "Assessed properties"],
  ["properties_with_accounts", "Properties with account associations"],
  ["source_business_accounts", "Distinct source TPP accounts"],
  ["matched_business_accounts", "Accounts with parcel candidates"],
  ["unmatched_business_accounts", "Valid unmatched accounts"],
  ["account_parcel_attributions", "Account–parcel associations (not businesses)"],
] as const;

export function BusinessView(): JSX.Element {
  const { source } = useDataSource();
  const view = useAsync(() => source.getBusinessView(), [source]);
  const [offset, setOffset] = useState(0);
  const [accountOffset, setAccountOffset] = useState(0);
  const [accountQuery, setAccountQuery] = useState("");
  const [accountLinkage, setAccountLinkage] = useState("all");
  const accountOptions = {
    q: accountQuery.trim() || undefined,
    linked: accountLinkage === "all" ? undefined : accountLinkage === "matched",
    limit: 50,
    offset: accountOffset,
  };
  const accounts = useAsync(async () => {
    if (!view.data?.businessesAvailable) return null;
    const [page, count] = await Promise.all([
      source.runSql(buildBusinessSearchSql(accountOptions), 50),
      source.runSql(buildBusinessSearchSql(accountOptions, true), 1),
    ]);
    return { ...page, matched: Number(count.rows[0]?.matched ?? 0) };
  }, [source, view.data?.businessesAvailable, JSON.stringify(accountOptions)]);

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
          {TOTAL_TILES.map(([key, label]) => (
            <StatTile
              key={key}
              label={label}
              loading={view.loading && !view.data}
              value={
                typeof view.data?.totals[key] === "number"
                  ? formatCount(view.data.totals[key])
                  : "—"
              }
              tone={key === "source_business_accounts" ? "accent" : "neutral"}
            />
          ))}
        </div>
        {view.data ? (
          <div style={{ marginTop: 14 }}>
            <SqlBlock provenance={view.data.provenance} />
          </div>
        ) : null}
      </Panel>

      <Panel
        title="All source business accounts"
        subtitle="Account-grain records remain searchable even when their address matches no assessed parcel."
      >
        {view.error ? (
          <div className="notice">
            Account-grain availability could not be read. This does not establish missing data or
            zero businesses.
          </div>
        ) : !view.loading && !view.data?.businessesAvailable ? (
          <div className="notice">
            This release does not include an account-grain business artifact. Missing availability
            is not a zero-business result.
          </div>
        ) : (
          <>
            <div className="filter-grid">
              <label>
                Business / account / situs address
                <input
                  value={accountQuery}
                  onChange={(event) => {
                    setAccountQuery(event.target.value);
                    setAccountOffset(0);
                  }}
                />
              </label>
              <label>
                Parcel candidate
                <select
                  value={accountLinkage}
                  onChange={(event) => {
                    setAccountLinkage(event.target.value);
                    setAccountOffset(0);
                  }}
                >
                  <option value="all">All accounts</option>
                  <option value="matched">Matched candidates</option>
                  <option value="unmatched">Valid unmatched accounts</option>
                </select>
              </label>
            </div>
            {accounts.error ? (
              <ErrorPanel error={accounts.error} onRetry={accounts.reload} />
            ) : null}
            <div className="table-scroll">
              <table className="data" style={{ minWidth: 800 }}>
                <thead>
                  <tr>
                    <th>Official account</th>
                    <th>Source-listed name / NAICS</th>
                    <th>Business situs</th>
                    <th>Parcel candidates</th>
                    <th>Provenance</th>
                  </tr>
                </thead>
                <tbody>
                  {(accounts.data?.rows ?? []).map((account) => (
                    <tr key={String(account.business_id)}>
                      <td>{String(account.account_id ?? "—")}</td>
                      <td>
                        {String(account.business_name ?? "—")}
                        <div className="micro">NAICS {String(account.naics_code ?? "unknown")}</div>
                      </td>
                      <td>
                        {String(account.situs_address ?? "unknown")}
                        <div className="micro">
                          {String(account.situs_city ?? "")} {String(account.situs_zip ?? "")}
                        </div>
                      </td>
                      <td>
                        {Number(account.matched_parcel_count) === 0
                          ? "Valid unmatched"
                          : `${Number(account.matched_parcel_count)} address candidate(s)`}
                      </td>
                      <td>
                        <a
                          href="https://floridarevenue.com/property/dataportal"
                          target="_blank"
                          rel="noreferrer"
                        >
                          DOR TPP source
                        </a>
                        <div className="micro">
                          {String(account.source_system ?? "unknown source")}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {accounts.data ? (
              <>
                <Pager
                  offset={accountOffset}
                  limit={50}
                  matched={accounts.data.matched}
                  returned={accounts.data.rows.length}
                  onOffset={setAccountOffset}
                  busy={accounts.loading}
                  noun="accounts"
                />
                <SqlBlock provenance={accounts.data.provenance} />
              </>
            ) : (
              <SkeletonRows rows={3} />
            )}
          </>
        )}
      </Panel>

      <div className="grid-2">
        <Panel title="Account–parcel associations by city">
          {view.loading && !view.data ? (
            <SkeletonRows rows={8} height={18} />
          ) : (
            <BarChart
              ariaLabel="Matched account–parcel associations by city"
              emptyText="No matched parcel groups are shown; unmatched source accounts are separate."
              data={(view.data?.byCity ?? []).slice(0, 20).map((entry) => ({
                label: entry.city,
                value: entry.business_accounts,
              }))}
            />
          )}
        </Panel>

        <Panel title="Account–parcel associations by property type">
          {view.loading && !view.data ? (
            <SkeletonRows rows={8} height={18} />
          ) : (
            <BarChart
              ariaLabel="Matched account–parcel associations by property type"
              emptyText="No matched property-type groups are shown; unmatched source accounts are separate."
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
