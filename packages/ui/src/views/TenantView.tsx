/**
 * Tenant view: who owns Lake County parcels, how long they have held them as
 * far as the published roll can tell, and how old the roofs are.
 *
 * The tenure caveat is rendered at the top rather than in a footnote, because
 * "no recorded sale" is the single easiest number on this page to over-read.
 */

import { useMemo, useState } from "react";
import {
  DEFAULT_ROOF_AGE_THRESHOLD_YEARS,
  TENURE_CAVEAT,
  type SearchOptions,
} from "@oracle-lake/shared";
import { BarChart, ROOF_BASIS_SERIES } from "../components/BarChart.js";
import { Pager } from "../components/Pager.js";
import { ErrorPanel, Panel, SkeletonRows, StatTile } from "../components/Primitives.js";
import { PropertyTable } from "../components/PropertyTable.js";
import { SqlBlock } from "../components/SqlBlock.js";
import { useDataSource } from "../data/DataSourceProvider.js";
import { useAsync } from "../hooks/useAsync.js";
import { navigate, propertyPath } from "../hooks/useHashRoute.js";
import { formatCount } from "../lib/format.js";

const POSTURE_TILES: readonly {
  key: string;
  label: string;
  tone?: "accent" | "warn";
  note?: string;
}[] = [
  { key: "properties", label: "Parcels", tone: "accent" },
  { key: "distinct_owners", label: "Distinct owner names" },
  { key: "out_of_county", label: "Owner mails out of county" },
  { key: "out_of_state", label: "Owner mails out of state", tone: "warn" },
  { key: "no_recorded_sale", label: "No sale in DOR window" },
  { key: "sale_on_record", label: "Sale date on the roll" },
  {
    key: "multi_owner",
    label: "More than one owner",
    note: "owner_count is 1 for every row in this roll",
  },
];

export function TenantView(): JSX.Element {
  const { source } = useDataSource();
  const view = useAsync(() => source.getTenantView(), [source]);

  const [outOfState, setOutOfState] = useState(true);
  const [noSale, setNoSale] = useState(false);
  const [minRoofAge, setMinRoofAge] = useState<number>(DEFAULT_ROOF_AGE_THRESHOLD_YEARS);
  const [useRoofAge, setUseRoofAge] = useState(false);
  const [offset, setOffset] = useState(0);

  const options = useMemo<SearchOptions>(
    () => ({
      ownerOutOfState: outOfState ? true : undefined,
      noRecordedSale: noSale ? true : undefined,
      minRoofAge: useRoofAge ? minRoofAge : undefined,
      sortBy: "roof_age_years",
      sortDir: "desc",
      limit: 50,
      offset,
    }),
    [outOfState, noSale, useRoofAge, minRoofAge, offset],
  );

  const results = useAsync(() => source.search(options), [source, JSON.stringify(options)]);

  return (
    <div className="stack">
      <div className="notice info">
        <span className="micro">tenure caveat</span>
        <p style={{ marginTop: 6, color: "var(--text)" }}>{TENURE_CAVEAT}</p>
      </div>

      <Panel
        title="Owner posture"
        subtitle="Every tile is a live aggregate over the published table."
      >
        {view.error ? <ErrorPanel error={view.error} onRetry={view.reload} /> : null}
        <div className="tile-grid">
          {POSTURE_TILES.map((tile) => (
            <StatTile
              key={tile.key}
              label={tile.label}
              loading={view.loading && !view.data}
              value={
                typeof view.data?.ownerPosture[tile.key] === "number"
                  ? formatCount(view.data.ownerPosture[tile.key])
                  : "—"
              }
              tone={tile.tone ?? "neutral"}
              note={tile.note}
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
        <Panel
          title="Owner mailing state"
          subtitle="Parcels whose owner mails somewhere other than Florida, by state."
        >
          {view.loading && !view.data ? (
            <SkeletonRows rows={8} height={18} />
          ) : (
            <BarChart
              ariaLabel="Parcels by owner mailing state, excluding Florida"
              emptyText="No out-of-state owner mailing addresses in the published roll."
              data={(view.data?.topOutOfStateOwners ?? []).map((entry) => ({
                label: entry.owner_mailing_state,
                value: entry.properties,
              }))}
            />
          )}
        </Panel>

        <Panel
          title="Roof age bands"
          subtitle="Split by the basis used to derive each parcel's roof age."
        >
          {view.loading && !view.data ? (
            <SkeletonRows rows={8} height={18} />
          ) : (
            <BarChart
              ariaLabel="Parcels by roof-age band, split by basis"
              data={(view.data?.roofAgeBands ?? []).map((band) => ({
                label: band.band === "unknown" ? "unknown" : `${band.band} yr`,
                value: band.properties,
                parts: [
                  { key: "from_completed_permit", value: band.from_completed_permit },
                  { key: "from_issued_permit", value: band.from_issued_permit },
                  { key: "from_year_built", value: band.from_year_built },
                ],
              }))}
              series={ROOF_BASIS_SERIES}
            />
          )}
        </Panel>
      </div>

      <Panel
        title="Parcels"
        subtitle="The same search engine as the Search tab, pre-filtered for tenure questions."
        actions={
          <div className="row">
            <label className={`toggle ${outOfState ? "on" : ""}`}>
              <input
                type="checkbox"
                checked={outOfState}
                onChange={(event) => {
                  setOutOfState(event.target.checked);
                  setOffset(0);
                }}
              />
              Owner out of state
            </label>
            <label className={`toggle ${noSale ? "on" : ""}`}>
              <input
                type="checkbox"
                checked={noSale}
                onChange={(event) => {
                  setNoSale(event.target.checked);
                  setOffset(0);
                }}
              />
              No sale in DOR window
            </label>
            <label className={`toggle ${useRoofAge ? "on" : ""}`}>
              <input
                type="checkbox"
                checked={useRoofAge}
                onChange={(event) => {
                  setUseRoofAge(event.target.checked);
                  setOffset(0);
                }}
              />
              Roof ≥
            </label>
            <input
              type="number"
              min={0}
              max={200}
              value={minRoofAge}
              aria-label="Minimum roof age in years"
              style={{ width: 74 }}
              onChange={(event) => {
                const parsed = Number(event.target.value);
                if (Number.isFinite(parsed)) {
                  setMinRoofAge(parsed);
                  setUseRoofAge(true);
                  setOffset(0);
                }
              }}
            />
            <span className="micro">years</span>
          </div>
        }
      >
        {results.error ? <ErrorPanel error={results.error} onRetry={results.reload} /> : null}
        <PropertyTable
          rows={results.data?.rows ?? []}
          loading={results.loading}
          onOpen={(parcelId) => navigate(propertyPath(parcelId))}
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
