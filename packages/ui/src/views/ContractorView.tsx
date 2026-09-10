/**
 * Contractor view: permit posture, and an unmissable statement of what is
 * missing.
 *
 * Contractor identity and BBB reputation are the two things a reader most
 * expects here and the two things the sources will not serve. Rather than
 * hiding the columns, the page leads with the gating notices and then proves
 * the claim with a live count: `contractor_names_present` and
 * `bbb_ratings_present` are queried out of the same table as everything else,
 * not asserted.
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
import { formatCount, formatDays, humanizeKey } from "../lib/format.js";

const POSTURE_TILES: readonly { key: string; label: string; tone?: "accent" | "warn" }[] = [
  { key: "properties_with_permits", label: "Parcels with permits", tone: "accent" },
  { key: "permit_records", label: "Permit records" },
  { key: "roofing_permit_records", label: "Roofing permit records" },
  { key: "open_permit_records", label: "Open permit records" },
  { key: "open_roofing_permit_records", label: "Open roofing permit records", tone: "warn" },
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
  const { source } = useDataSource();
  const view = useAsync(() => source.getContractorView(), [source]);
  const stats = useAsync(() => source.getStats(), [source]);
  const [offset, setOffset] = useState(0);

  const options = useMemo<SearchOptions>(
    () => ({
      hasOpenRoofingPermit: true,
      sortBy: "longest_open_permit_days",
      sortDir: "desc",
      limit: 50,
      offset,
    }),
    [offset],
  );

  const results = useAsync(() => source.search(options), [source, JSON.stringify(options)]);

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
              Two columns in the published table are always null. They are published anyway, because
              a missing column and an empty column say different things.
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
                <span className="micro">column {notice.field} · stays null</span>
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
                ? `out of ${formatCount(totalParcels)} parcels · queried, not asserted`
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
        subtitle="Aggregated from the Lake County CD Plus permit layer."
      >
        <div className="tile-grid">
          {POSTURE_TILES.map((tile) => (
            <StatTile
              key={tile.key}
              label={tile.label}
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
            label="Longest open permit"
            loading={view.loading && !view.data}
            value={formatDays(view.data?.posture.longest_open_permit_days)}
          />
        </div>
      </Panel>

      <Panel
        title="How long open permits have been open"
        subtitle="Bucketed from longest_open_permit_days on each parcel."
      >
        {view.loading && !view.data ? (
          <SkeletonRows rows={4} height={18} />
        ) : (
          <BarChart
            ariaLabel="Parcels by how long their longest open permit has been open"
            emptyText="No open permits in the published table."
            data={DURATION_BUCKETS.map((bucket) => ({
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
        title="Parcels with an open roofing permit"
        subtitle="Ordered by the longest permit still open, descending."
      >
        {results.error ? <ErrorPanel error={results.error} onRetry={results.reload} /> : null}
        <PropertyTable
          rows={results.data?.rows ?? []}
          loading={results.loading}
          onOpen={(parcelId) => navigate(propertyPath(parcelId))}
          emptyText="No parcel in the published table has an open roofing permit."
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
