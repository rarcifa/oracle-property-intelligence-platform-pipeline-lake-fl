/**
 * Search: the filter rail, the map, the results table and the SQL behind them.
 *
 * The rail's controls map one-to-one onto the shared `PropertyFilters`, so the
 * generated SQL shown under the table is literally the query that produced the
 * rows above it. The roof-age threshold defaults to the pipeline's own
 * `DEFAULT_ROOF_AGE_THRESHOLD_YEARS` rather than a number typed in here.
 */

import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_ROOF_AGE_THRESHOLD_YEARS,
  DEFAULT_SEARCH_LIMIT,
  ROOF_AGE_BASIS_LABELS,
  type SearchOptions,
} from "@oracle-lake/shared";
import { Pager } from "../components/Pager.js";
import { ErrorPanel, Panel, Skeleton } from "../components/Primitives.js";
import { PropertyTable } from "../components/PropertyTable.js";
import { SqlBlock } from "../components/SqlBlock.js";
import { SemanticSearchPanel } from "./SemanticSearchPanel.js";
import { useDataSource } from "../data/DataSourceProvider.js";
import { useAsync } from "../hooks/useAsync.js";
import { useDebouncedValue } from "../hooks/useDebouncedValue.js";
import { navigate, propertyPath } from "../hooks/useHashRoute.js";
import { formatCount } from "../lib/format.js";

/**
 * MapLibre is the single largest dependency in the bundle and only this view
 * needs it, so it is code-split behind a skeleton.
 */
const MapPanel = lazy(async () => {
  const module = await import("../components/MapPanel.js");
  return { default: module.MapPanel };
});

interface Draft {
  q: string;
  city: string;
  propertyType: string;
  zip: string;
  roofAgeBasis: string;
  useRoofAge: boolean;
  minRoofAge: number;
  hasPermits: boolean;
  hasOpenRoofingPermit: boolean;
  ownerOutOfCounty: boolean;
  ownerOutOfState: boolean;
  noRecordedSale: boolean;
  hasBusinessAccount: boolean;
  minMarketValue: string;
  maxMarketValue: string;
  minBuiltYear: string;
  maxBuiltYear: string;
  lat: string;
  lon: string;
  radiusMiles: string;
  requireCoordinates: boolean;
}

const EMPTY_DRAFT: Draft = {
  q: "",
  city: "",
  propertyType: "",
  zip: "",
  roofAgeBasis: "",
  useRoofAge: false,
  minRoofAge: DEFAULT_ROOF_AGE_THRESHOLD_YEARS,
  hasPermits: false,
  hasOpenRoofingPermit: false,
  ownerOutOfCounty: false,
  ownerOutOfState: false,
  noRecordedSale: false,
  hasBusinessAccount: false,
  minMarketValue: "",
  maxMarketValue: "",
  minBuiltYear: "",
  maxBuiltYear: "",
  lat: "",
  lon: "",
  radiusMiles: "",
  requireCoordinates: false,
};

/** Parse a text input into a finite number, or `undefined` when blank/invalid. */
function numberOrUndefined(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Turn the rail's draft state into the shared filter object. */
function toOptions(
  draft: Draft,
  sortBy: string | undefined,
  sortDir: "asc" | "desc",
  offset: number,
): SearchOptions {
  const lat = numberOrUndefined(draft.lat);
  const lon = numberOrUndefined(draft.lon);
  const radiusMiles = numberOrUndefined(draft.radiusMiles);
  const radiusReady =
    typeof lat === "number" &&
    typeof lon === "number" &&
    typeof radiusMiles === "number" &&
    radiusMiles > 0;

  return {
    q: draft.q.trim() || undefined,
    city: draft.city || undefined,
    propertyType: draft.propertyType || undefined,
    zip: draft.zip.trim() || undefined,
    roofAgeBasis: draft.roofAgeBasis || undefined,
    minRoofAge: draft.useRoofAge ? draft.minRoofAge : undefined,
    hasPermits: draft.hasPermits ? true : undefined,
    hasOpenRoofingPermit: draft.hasOpenRoofingPermit ? true : undefined,
    ownerOutOfCounty: draft.ownerOutOfCounty ? true : undefined,
    ownerOutOfState: draft.ownerOutOfState ? true : undefined,
    noRecordedSale: draft.noRecordedSale ? true : undefined,
    hasBusinessAccount: draft.hasBusinessAccount ? true : undefined,
    minMarketValue: numberOrUndefined(draft.minMarketValue),
    maxMarketValue: numberOrUndefined(draft.maxMarketValue),
    minBuiltYear: numberOrUndefined(draft.minBuiltYear),
    maxBuiltYear: numberOrUndefined(draft.maxBuiltYear),
    requireCoordinates: draft.requireCoordinates ? true : undefined,
    lat: radiusReady ? lat : undefined,
    lon: radiusReady ? lon : undefined,
    radiusMiles: radiusReady ? radiusMiles : undefined,
    sortBy,
    sortDir,
    limit: DEFAULT_SEARCH_LIMIT,
    offset,
  };
}

export function SearchView(): JSX.Element {
  const { source } = useDataSource();
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [sortBy, setSortBy] = useState<string | undefined>(undefined);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [offset, setOffset] = useState(0);
  const [railOpen, setRailOpen] = useState(true);

  const debouncedDraft = useDebouncedValue(draft, 300);

  const facets = useAsync(() => source.getFacets(), [source]);

  const options = useMemo(
    () => toOptions(debouncedDraft, sortBy, sortDir, offset),
    [debouncedDraft, sortBy, sortDir, offset],
  );

  const filterKey = useMemo(
    () => JSON.stringify({ ...toOptions(debouncedDraft, sortBy, sortDir, 0) }),
    [debouncedDraft, sortBy, sortDir],
  );

  // Any change to the filters or ordering returns to the first page.
  useEffect(() => {
    setOffset(0);
  }, [filterKey]);

  const results = useAsync(() => source.search(options), [source, JSON.stringify(options)]);

  const update = <K extends keyof Draft>(key: K, value: Draft[K]): void => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const onSort = (column: string): void => {
    if (sortBy === column) {
      setSortDir((direction) => (direction === "asc" ? "desc" : "asc"));
      return;
    }
    setSortBy(column);
    setSortDir("desc");
  };

  const rows = results.data?.rows ?? [];
  const centre =
    typeof options.lat === "number" && typeof options.lon === "number"
      ? { lat: options.lat, lon: options.lon }
      : null;

  const activeFilterCount = Object.entries(options).filter(
    ([key, value]) =>
      value !== undefined &&
      key !== "limit" &&
      key !== "offset" &&
      key !== "sortDir" &&
      key !== "sortBy",
  ).length;

  return (
    <div className="search-layout">
      <aside
        className="filter-rail"
        data-collapsed={railOpen ? "false" : "true"}
        aria-label="Filters"
      >
        <div className="filter-section">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="micro">
              Filters {activeFilterCount > 0 ? `· ${activeFilterCount} active` : ""}
            </span>
            <button type="button" className="btn small ghost" onClick={() => setDraft(EMPTY_DRAFT)}>
              Reset
            </button>
          </div>

          <div className="field" style={{ marginTop: 10 }}>
            <label htmlFor="filter-q">Parcel id, address or owner</label>
            <input
              id="filter-q"
              type="search"
              value={draft.q}
              placeholder="e.g. CLERMONT or 05-18-25"
              onChange={(event) => update("q", event.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="filter-city">City</label>
            <select
              id="filter-city"
              value={draft.city}
              onChange={(event) => update("city", event.target.value)}
            >
              <option value="">Any city</option>
              {(facets.data?.cities ?? []).map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.value} ({formatCount(entry.count)})
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="filter-type">Property type</label>
            <select
              id="filter-type"
              value={draft.propertyType}
              onChange={(event) => update("propertyType", event.target.value)}
            >
              <option value="">Any type</option>
              {(facets.data?.propertyTypes ?? []).map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.value} ({formatCount(entry.count)})
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="filter-zip">ZIP</label>
            <input
              id="filter-zip"
              type="text"
              inputMode="numeric"
              value={draft.zip}
              onChange={(event) => update("zip", event.target.value)}
              placeholder="Any ZIP"
            />
          </div>
        </div>

        <div className="filter-section">
          <span className="micro">Roof age</span>
          <label className={`toggle ${draft.useRoofAge ? "on" : ""}`} style={{ marginTop: 8 }}>
            <input
              type="checkbox"
              checked={draft.useRoofAge}
              onChange={(event) => update("useRoofAge", event.target.checked)}
            />
            Roof at least {draft.minRoofAge} years old
          </label>
          <div className="pair" style={{ marginTop: 8 }}>
            <div className="field">
              <label htmlFor="filter-roof-range">Threshold (years)</label>
              <input
                id="filter-roof-range"
                type="range"
                min={0}
                max={80}
                step={1}
                value={draft.minRoofAge}
                onChange={(event) => {
                  update("minRoofAge", Number(event.target.value));
                  update("useRoofAge", true);
                }}
              />
            </div>
            <div className="field">
              <label htmlFor="filter-roof-number">Exact</label>
              <input
                id="filter-roof-number"
                type="number"
                min={0}
                max={200}
                value={draft.minRoofAge}
                onChange={(event) => {
                  const parsed = Number(event.target.value);
                  if (Number.isFinite(parsed)) update("minRoofAge", parsed);
                }}
              />
            </div>
          </div>
          <div className="field" style={{ marginTop: 8 }}>
            <label htmlFor="filter-basis">Roof age basis</label>
            <select
              id="filter-basis"
              value={draft.roofAgeBasis}
              onChange={(event) => update("roofAgeBasis", event.target.value)}
            >
              <option value="">Any basis</option>
              {(facets.data?.roofAgeBasis ?? []).map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {ROOF_AGE_BASIS_LABELS[entry.value] ?? entry.value} ({formatCount(entry.count)})
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="filter-section">
          <span className="micro">Signals</span>
          <div style={{ marginTop: 6 }}>
            <Toggle
              label="Has permits on record"
              checked={draft.hasPermits}
              onChange={(value) => update("hasPermits", value)}
            />
            <Toggle
              label="Open roofing permit"
              checked={draft.hasOpenRoofingPermit}
              onChange={(value) => update("hasOpenRoofingPermit", value)}
            />
            <Toggle
              label="Owner mails out of county"
              checked={draft.ownerOutOfCounty}
              onChange={(value) => update("ownerOutOfCounty", value)}
            />
            <Toggle
              label="Owner mails out of state"
              checked={draft.ownerOutOfState}
              onChange={(value) => update("ownerOutOfState", value)}
            />
            <Toggle
              label="No sale in the DOR window"
              checked={draft.noRecordedSale}
              onChange={(value) => update("noRecordedSale", value)}
            />
            <Toggle
              label="Has a TPP business account"
              checked={draft.hasBusinessAccount}
              onChange={(value) => update("hasBusinessAccount", value)}
            />
            <Toggle
              label="Only parcels with coordinates"
              checked={draft.requireCoordinates}
              onChange={(value) => update("requireCoordinates", value)}
            />
          </div>
        </div>

        <div className="filter-section">
          <span className="micro">Market value (USD)</span>
          <div className="pair" style={{ marginTop: 8 }}>
            <div className="field">
              <label htmlFor="filter-min-value">Minimum</label>
              <input
                id="filter-min-value"
                type="number"
                min={0}
                value={draft.minMarketValue}
                onChange={(event) => update("minMarketValue", event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="filter-max-value">Maximum</label>
              <input
                id="filter-max-value"
                type="number"
                min={0}
                value={draft.maxMarketValue}
                onChange={(event) => update("maxMarketValue", event.target.value)}
              />
            </div>
          </div>
          <span className="micro" style={{ display: "block", marginTop: 12 }}>
            Year built
          </span>
          <div className="pair" style={{ marginTop: 8 }}>
            <div className="field">
              <label htmlFor="filter-min-year">From</label>
              <input
                id="filter-min-year"
                type="number"
                value={draft.minBuiltYear}
                onChange={(event) => update("minBuiltYear", event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="filter-max-year">To</label>
              <input
                id="filter-max-year"
                type="number"
                value={draft.maxBuiltYear}
                onChange={(event) => update("maxBuiltYear", event.target.value)}
              />
            </div>
          </div>
        </div>

        <div className="filter-section">
          <span className="micro">Radius search</span>
          <p className="prose" style={{ fontSize: 11.5, marginTop: 6 }}>
            All three values are required together; the SQL builder rejects a partial radius.
          </p>
          <div className="pair">
            <div className="field">
              <label htmlFor="filter-lat">Latitude</label>
              <input
                id="filter-lat"
                type="number"
                step="0.000001"
                value={draft.lat}
                onChange={(event) => update("lat", event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="filter-lon">Longitude</label>
              <input
                id="filter-lon"
                type="number"
                step="0.000001"
                value={draft.lon}
                onChange={(event) => update("lon", event.target.value)}
              />
            </div>
          </div>
          <div className="field" style={{ marginTop: 8 }}>
            <label htmlFor="filter-radius">Radius (miles)</label>
            <input
              id="filter-radius"
              type="number"
              min={0}
              step="0.25"
              value={draft.radiusMiles}
              onChange={(event) => update("radiusMiles", event.target.value)}
            />
          </div>
          <button
            type="button"
            className="btn small ghost"
            style={{ marginTop: 8 }}
            onClick={() =>
              setDraft((current) => ({ ...current, lat: "", lon: "", radiusMiles: "" }))
            }
          >
            Clear radius
          </button>
        </div>
      </aside>

      <div className="stack" style={{ minWidth: 0 }}>
        <button
          type="button"
          className="btn rail-toggle"
          onClick={() => setRailOpen((value) => !value)}
          aria-expanded={railOpen}
        >
          {railOpen
            ? "Hide filters"
            : `Show filters${activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}`}
        </button>

        <SemanticSearchPanel
          onFilters={(filters) => {
            // Drive the rail from the interpretation, so the grid and the panel
            // answer the same question and every applied filter is visible and
            // editable rather than hidden inside the panel.
            setDraft((current) => ({
              ...EMPTY_DRAFT,
              q: typeof filters.q === "string" ? filters.q : "",
              city: typeof filters.city === "string" ? filters.city : "",
              propertyType: typeof filters.propertyType === "string" ? filters.propertyType : "",
              useRoofAge: typeof filters.minRoofAge === "number",
              minRoofAge:
                typeof filters.minRoofAge === "number" ? filters.minRoofAge : current.minRoofAge,
              hasPermits: filters.hasPermits === true,
              hasOpenRoofingPermit: filters.hasOpenRoofingPermit === true,
              ownerOutOfCounty: filters.ownerOutOfCounty === true,
              ownerOutOfState: filters.ownerOutOfState === true,
              noRecordedSale: filters.noRecordedSale === true,
              hasBusinessAccount: filters.hasBusinessAccount === true,
              minMarketValue:
                typeof filters.minMarketValue === "number" ? String(filters.minMarketValue) : "",
              maxMarketValue:
                typeof filters.maxMarketValue === "number" ? String(filters.maxMarketValue) : "",
              minBuiltYear:
                typeof filters.minBuiltYear === "number" ? String(filters.minBuiltYear) : "",
              maxBuiltYear:
                typeof filters.maxBuiltYear === "number" ? String(filters.maxBuiltYear) : "",
            }));
          }}
        />

        <Panel
          title="Map"
          subtitle="Click to set the radius centre. Dots are the parcels in the current result page that carry coordinates."
        >
          <Suspense fallback={<Skeleton height={360} radius={10} />}>
            <MapPanel
              rows={rows}
              center={centre}
              radiusMiles={typeof options.radiusMiles === "number" ? options.radiusMiles : null}
              onPick={(lat, lon) =>
                setDraft((current) => ({
                  ...current,
                  lat: lat.toFixed(6),
                  lon: lon.toFixed(6),
                  radiusMiles: current.radiusMiles.trim().length > 0 ? current.radiusMiles : "1",
                }))
              }
              onOpenProperty={(parcelId) => navigate(propertyPath(parcelId))}
            />
          </Suspense>
        </Panel>

        <Panel
          title="Results"
          actions={results.loading ? <span className="micro">querying…</span> : null}
        >
          {results.error ? <ErrorPanel error={results.error} onRetry={results.reload} /> : null}
          <PropertyTable
            rows={rows}
            loading={results.loading}
            sort={{ sortBy, sortDir }}
            onSort={onSort}
            onOpen={(parcelId) => navigate(propertyPath(parcelId))}
            showDistance={typeof options.radiusMiles === "number"}
          />
          {results.data ? (
            <Pager
              offset={results.data.offset}
              limit={results.data.limit}
              matched={results.data.matched}
              returned={results.data.rows.length}
              onOffset={setOffset}
              busy={results.loading}
            />
          ) : null}
          {results.data ? (
            <div style={{ marginTop: 12 }}>
              <SqlBlock provenance={results.data.provenance} open />
            </div>
          ) : null}
        </Panel>
      </div>
    </div>
  );
}

/** A labelled checkbox that also carries its state in words. */
function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}): JSX.Element {
  return (
    <label className={`toggle ${checked ? "on" : ""}`}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}
