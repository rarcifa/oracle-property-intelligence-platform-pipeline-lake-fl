/**
 * Overview: the run, its coverage, and the headline counts.
 *
 * Every tile is a live aggregate from `getStats()`; nothing on this page is a
 * constant. The documented limitations from the published `coverage.json` are
 * rendered expanded, one card each, because an honest coverage statement that
 * has to be clicked open is not an honest coverage statement.
 */

import { gatewayUrl, UNUSABLE_IPFS_GATEWAYS } from "@oracle-lake/shared";
import { BarChart, ROOF_BASIS_SERIES } from "../components/BarChart.js";
import {
  Badge,
  EmptyState,
  ErrorPanel,
  Panel,
  SkeletonRows,
  StatTile,
} from "../components/Primitives.js";
import { SqlBlock } from "../components/SqlBlock.js";
import { useDataSource } from "../data/DataSourceProvider.js";
import { useAsync } from "../hooks/useAsync.js";
import { useCopy } from "../hooks/useCopy.js";
import { formatCount, formatPercent, humanizeKey, shortCid } from "../lib/format.js";

const TILES: readonly {
  key: string;
  label: string;
  note?: string;
  tone?: "accent" | "warn" | "ok";
}[] = [
  { key: "properties", label: "Parcels in query table", tone: "accent" },
  { key: "with_coordinates", label: "With GIO centroid" },
  { key: "roof_age_known", label: "Roof age derived" },
  { key: "roof_age_15_plus", label: "Roof age 15+ years", tone: "warn" },
  { key: "with_permits", label: "Parcels with permits" },
  { key: "permit_records", label: "Permit records joined" },
  { key: "roofing_permit_records", label: "Roofing permit records" },
  { key: "with_open_roofing_permit", label: "Open roofing permits", tone: "warn" },
  { key: "open_over_five_years", label: "Open over five years", tone: "warn" },
  { key: "owner_out_of_county", label: "Owner out of county" },
  { key: "owner_out_of_state", label: "Owner out of state" },
  { key: "no_recorded_sale", label: "No sale in DOR window" },
  { key: "distinct_owners", label: "Distinct owner names" },
  { key: "with_business_account", label: "Parcels with TPP accounts" },
  {
    key: "business_accounts",
    label: "TPP account–parcel matches",
    note: "shared addresses counted per parcel",
  },
  { key: "contractor_names_present", label: "Contractor names present", note: "gated at source" },
  { key: "bbb_ratings_present", label: "BBB ratings present", note: "gated at source" },
];

export function OverviewView(): JSX.Element {
  const { source, meta, metaError, mode } = useDataSource();
  const { copied, copy } = useCopy();
  const stats = useAsync(() => source.getStats(), [source]);

  const run = meta?.run ?? null;
  const coverage = meta?.coverage ?? null;
  const verification = meta?.verification ?? null;
  const runHistory = meta?.runHistory ?? null;
  const total = stats.data?.stats.properties ?? 0;

  return (
    <div className="stack">
      <Panel
        title="Published run"
        subtitle="One immutable columnar table, addressed by CID. Every figure below is a query against it."
      >
        {metaError ? <ErrorPanel error={metaError} /> : null}
        {!meta && !metaError ? <SkeletonRows rows={4} /> : null}
        {run ? (
          <div className="kv-list">
            <Kv label="Run id" value={run.runId} onCopy={copy} copied={copied} />
            <Kv label="Root CID" value={run.rootCid} onCopy={copy} copied={copied} mono />
            <Kv label="Manifest CID" value={run.manifestCid} onCopy={copy} copied={copied} mono />
            <Kv label="CAR CID" value={run.carCid} onCopy={copy} copied={copied} mono />
            <Kv label="IPNS name" value={run.ipnsName} onCopy={copy} copied={copied} mono />
            <Kv
              label="IPNS resolves to"
              value={run.resolvedCid}
              onCopy={copy}
              copied={copied}
              mono
            />
            <Kv
              label="Verified gateways"
              value={run.verifiedGateways.length > 0 ? run.verifiedGateways.join(", ") : null}
              note={
                run.verifiedGateways.some((gateway) => /ipfs\.io|dweb\.link/.test(gateway))
                  ? "ipfs.io and dweb.link rate-limit datacenter egress, so a reviewer on cloud infrastructure typically reproduces the first three, not all five."
                  : undefined
              }
            />
            <Kv label="Properties in pointer" value={formatCount(run.propertyCount)} />
            <Kv
              label="Data path in use"
              value={mode === "browser" ? "Browser DuckDB-WASM" : "Server DuckDB"}
            />
            <Kv label="Reading from" value={source.dataSource} />
          </div>
        ) : null}
      </Panel>

      <Panel
        title="Run history"
        subtitle="Every publish, with its CIDs and the record deltas it produced. A run never overwrites the one before it. The timestamps are when the publish set was assembled, not ingest wall-clock — both runs here were published in the same batch, which is why they are seconds apart while their run ids are 27 minutes apart."
      >
        {runHistory === null || runHistory.runs.length === 0 ? (
          <p className="dim" style={{ margin: 0 }}>
            No run history was found, so this app makes no claim about previous publishes.
          </p>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Mode</th>
                  <th>Finished</th>
                  <th>Root CID</th>
                  <th className="num">Rows</th>
                  <th className="num">Inserted</th>
                  <th className="num">Updated</th>
                  <th className="num">Unchanged</th>
                </tr>
              </thead>
              <tbody>
                {[...runHistory.runs]
                  .sort((a, b) => b.runId.localeCompare(a.runId))
                  .map((entry) => {
                    const properties = entry.tables?.find((table) => table.name === "properties");
                    return (
                      <tr key={entry.runId}>
                        <td className="mono">{entry.runId}</td>
                        <td>{entry.mode ?? "—"}</td>
                        <td className="mono">
                          {entry.finishedAt ? entry.finishedAt.replace("T", " ").slice(0, 19) : "—"}
                        </td>
                        <td className="mono" title={entry.rootCid ?? undefined}>
                          {entry.rootCid
                            ? `${entry.rootCid.slice(0, 10)}…${entry.rootCid.slice(-6)}`
                            : "—"}
                        </td>
                        <td className="num">{formatCount(properties?.rows)}</td>
                        <td className="num">{formatCount(properties?.inserted)}</td>
                        <td className="num">{formatCount(properties?.updated)}</td>
                        <td className="num">{formatCount(properties?.unchanged)}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel
        title="Independent gateway verification"
        subtitle="Each published artifact was fetched from several independent IPFS gateways and hashed. Identical SHA-256 across gateways is what makes the CID checkable rather than claimed."
      >
        {verification === null ? (
          <EmptyState>
            No verification report was found for this run, so this app makes no verification claim.
          </EmptyState>
        ) : (
          <>
            <div className="table-scroll">
              <table className="data" style={{ minWidth: 560 }}>
                <thead>
                  <tr>
                    <th scope="col">Artifact</th>
                    <th scope="col">CID</th>
                    <th scope="col">Result</th>
                    <th scope="col" className="num">
                      Gateways agreeing
                    </th>
                    <th scope="col">SHA-256</th>
                  </tr>
                </thead>
                <tbody>
                  {verification.verifications.map((entry) => {
                    const digest =
                      entry.results.find((result) => result.sha256 !== null)?.sha256 ?? null;
                    return (
                      <tr key={entry.name}>
                        <td className="mono">{entry.name}</td>
                        <td className="mono muted">{shortCid(entry.cid)}</td>
                        <td>
                          <Badge tone={entry.verified ? "ok" : "warn"}>
                            {entry.verified ? "byte-identical" : "not verified"}
                          </Badge>
                        </td>
                        <td className="num" title={entry.matchedGateways.join(", ")}>
                          {formatCount(entry.matchedGateways.length)} of{" "}
                          {formatCount(entry.results.length)}
                        </td>
                        <td className="mono muted">
                          {digest === null
                            ? "—"
                            : `${digest.replace(/^sha256:/, "").slice(0, 16)}…`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="micro muted" style={{ marginTop: 10 }}>
              Verified for run <span className="mono">{verification.runId}</span> at root{" "}
              <span className="mono">{shortCid(verification.rootCid)}</span>
              {runHistory === null
                ? null
                : ` · ${formatCount(runHistory.runs.length)} publish ${
                    runHistory.runs.length === 1 ? "run" : "runs"
                  } recorded in run-history.json`}
              .
            </p>
          </>
        )}
      </Panel>

      <Panel
        title="Dataset at a glance"
        subtitle="Counts are computed on demand, never stored in this app."
        actions={
          stats.loading ? (
            <span className="micro">querying…</span>
          ) : (
            <button type="button" className="btn small ghost" onClick={stats.reload}>
              Re-run
            </button>
          )
        }
      >
        {stats.error ? <ErrorPanel error={stats.error} onRetry={stats.reload} /> : null}
        <div className="tile-grid">
          {TILES.map((tile) => {
            const value = stats.data?.stats[tile.key];
            const share =
              total > 0 && typeof value === "number" && tile.key !== "properties"
                ? `${formatPercent(value, total)} of parcels`
                : undefined;
            return (
              <StatTile
                key={tile.key}
                label={tile.label}
                loading={stats.loading && !stats.data}
                value={typeof value === "number" ? formatCount(value) : "—"}
                note={tile.note ?? share}
                tone={tile.tone ?? "neutral"}
              />
            );
          })}
        </div>
        {stats.data ? (
          <div style={{ marginTop: 14 }}>
            <SqlBlock provenance={stats.data.provenance} />
          </div>
        ) : null}
      </Panel>

      <Panel
        title="Roof age by band and basis"
        subtitle="Roof age comes from a completed roofing permit where one exists, then an issued permit, then year built. The basis is published per parcel so a reader can see which."
      >
        {stats.loading && !stats.data ? (
          <SkeletonRows rows={7} height={20} />
        ) : (
          <BarChart
            ariaLabel="Parcels by roof-age band, split by the basis used to derive the age"
            data={(stats.data?.roofAgeBands ?? []).map((band) => ({
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

      <Panel
        title="Documented limitations"
        subtitle="Published verbatim from the run's coverage snapshot. These are the things this dataset does not know, and why."
      >
        {!coverage ? (
          <SkeletonRows rows={4} height={40} />
        ) : coverage.limitations.length === 0 ? (
          <EmptyState>The coverage snapshot records no limitations.</EmptyState>
        ) : (
          <div className="limitation-grid">
            {coverage.limitations.map((limitation, index) => (
              <div className="limitation-card" key={index}>
                <span className="micro">limitation {index + 1}</span>
                <span>{limitation}</span>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <div className="grid-2">
        <Panel
          title="Coverage by table"
          subtitle="Row counts and the upstream system each table came from, as published."
        >
          {!coverage ? (
            <SkeletonRows rows={5} />
          ) : (
            <>
              <div className="table-scroll">
                <table className="data" style={{ minWidth: 420 }}>
                  <thead>
                    <tr>
                      <th scope="col">Table</th>
                      <th scope="col" className="num">
                        Rows
                      </th>
                      <th scope="col">Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(coverage.tables).map(([name, entry]) => (
                      <tr key={name}>
                        <td className="mono">{name}</td>
                        <td className="num">{formatCount(entry.rows)}</td>
                        <td className="muted">{entry.source}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="kv-list" style={{ marginTop: 12 }}>
                <div className="kv">
                  <span>Denominator basis</span>
                  <span>{coverage.denominator.basis}</span>
                </div>
                <div className="kv">
                  <span>Denominator source</span>
                  <span>{coverage.denominator.source}</span>
                </div>
                <div className="kv">
                  <span>Assessed parcels</span>
                  <span>{formatCount(coverage.denominator.assessedParcelCount)}</span>
                </div>
                <div className="kv">
                  <span>Exported at</span>
                  <span>{coverage.exportedAt}</span>
                </div>
              </div>
              {Object.keys(coverage.signals).length > 0 ? (
                <div style={{ marginTop: 12 }}>
                  <span className="micro">signals recorded at publish time</span>
                  <div className="kv-list">
                    {Object.entries(coverage.signals).map(([key, value]) => (
                      <div className="kv" key={key}>
                        <span>{humanizeKey(key)}</span>
                        <span>{formatCount(value)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          )}
        </Panel>

        <Panel
          title="Gateways"
          subtitle="Where the published bytes can be fetched, and which gateways this app refuses to use."
        >
          {!meta || !run ? (
            <SkeletonRows rows={4} />
          ) : (
            <div className="gateway-list">
              {meta.gateways.map((gateway) => (
                <div className="gateway-row" key={gateway.id}>
                  <div className="stack-sm" style={{ minWidth: 0 }}>
                    <div className="row">
                      <strong>{gateway.id}</strong>
                      <Badge tone={gateway.cors ? "ok" : "neutral"}>
                        {gateway.cors ? "CORS" : "no CORS"}
                      </Badge>
                      <Badge tone={gateway.range ? "ok" : "neutral"}>
                        {gateway.range ? "HTTP Range" : "no Range"}
                      </Badge>
                    </div>
                    <a
                      href={gatewayUrl(gateway, run.rootCid, "query-table.parquet")}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {gatewayUrl(gateway, run.rootCid, "query-table.parquet")}
                    </a>
                    <span className="dim" style={{ fontSize: 11 }}>
                      {gateway.note}
                    </span>
                  </div>
                  <a
                    href={gatewayUrl(gateway, run.manifestCid)}
                    target="_blank"
                    rel="noreferrer"
                    className="btn small ghost"
                  >
                    manifest
                  </a>
                </div>
              ))}
              <div className="notice" style={{ marginTop: 4 }}>
                <span className="micro">gateways we deliberately do not use</span>
                <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 12.5 }}>
                  {(meta.unusableGateways.length > 0
                    ? meta.unusableGateways
                    : UNUSABLE_IPFS_GATEWAYS
                  ).map((entry) => (
                    <li key={entry.host} className="muted">
                      <span className="mono">{entry.host}</span> — {entry.reason}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

/** One label/value row, with click-to-copy on the values worth copying. */
function Kv({
  label,
  value,
  mono = false,
  onCopy,
  copied,
  note,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
  onCopy?: (text: string) => void;
  copied?: string | null;
  /** Caveat shown under the value, for a figure that needs one to be honest. */
  note?: string;
}): JSX.Element {
  const display = value === null ? "—" : mono ? shortCid(value, 14, 8) : value;
  return (
    <div className="kv">
      <span>{label}</span>
      {value && onCopy ? (
        <button
          type="button"
          className="parcel-chip"
          onClick={() => onCopy(value)}
          title={value}
          aria-label={`Copy ${label}`}
        >
          {display} {copied === value ? "✓" : "⧉"}
        </button>
      ) : (
        <span title={value ?? undefined}>{display}</span>
      )}
      {note ? (
        <span className="dim" style={{ fontSize: 11, display: "block", marginTop: 2 }}>
          {note}
        </span>
      ) : null}
    </div>
  );
}
