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
  { key: "permit_records", label: "Total permit records" },
  { key: "permit_records_linked", label: "Permit records linked to parcels" },
  {
    key: "permit_records_valid_unlinked",
    label: "Valid unlinked permit records",
    note: "retained in the permit table, without a parcel link",
  },
  { key: "roofing_permit_records", label: "Linked roofing permit records" },
  { key: "with_open_roofing_permit", label: "Parcels with open roofing permits", tone: "warn" },
  {
    key: "open_roofing_over_five_years",
    label: "Parcels with roofing open over five years",
    tone: "warn",
  },
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
  {
    // Not "gated at source" any more: Clermont's eTRAKiT portal publishes a
    // contractor of record and is harvested. The note has to carry the
    // denominator, or a non-zero count on this page reads as county coverage.
    key: "contractor_names_present",
    label: "Contractor names present",
    note: "Clermont only (1 of 15 jurisdictions)",
  },
  { key: "bbb_ratings_present", label: "BBB ratings present", note: "gated at source" },
];

export function OverviewView(): JSX.Element {
  const { source, meta, metaError, mode } = useDataSource();
  const { copied, copy } = useCopy();
  const stats = useAsync(() => source.getStats(), [source]);

  const run = meta?.run ?? null;
  const rootCid = run?.rootCid ?? null;
  const candidateEvidence = meta?.publicationEvidence ?? null;
  const publicationEvidence =
    run && candidateEvidence?.runId === run.runId && candidateEvidence.rootCid === rootCid
      ? candidateEvidence
      : null;
  const manifestCid = run?.manifestCid ?? publicationEvidence?.manifestCid ?? null;
  const carCid = run?.carCid ?? publicationEvidence?.carCid ?? null;
  const coverage = meta?.coverage ?? null;
  const verification = meta?.verification ?? null;
  const runHistory = meta?.runHistory ?? null;
  const verifiedGateways =
    run?.verifiedGateways && run.verifiedGateways.length > 0
      ? run.verifiedGateways
      : (publicationEvidence?.verifiedGateways ?? []);
  const evidenceOnly = meta?.sourceObservationsOnly === true || meta?.localEvidencePreview === true;
  const total = stats.data?.stats.properties ?? 0;

  return (
    <div className="stack">
      <Panel
        title={
          meta?.localEvidencePreview
            ? "Local unaccepted preview"
            : meta?.sourceObservationsOnly
              ? "Source-only partial run"
              : "Published run"
        }
        subtitle={
          evidenceOnly
            ? "Partial historical source observations and low-confidence building-year proxies. This selection does not establish county completeness or accepted permit lifecycle semantics."
            : "The served query table and its recorded publication identity."
        }
      >
        {metaError ? <ErrorPanel error={metaError} /> : null}
        {evidenceOnly ? (
          <p className="notice gated">
            Current/open permit status, completion, verified company/license identity and BBB
            ratings remain unaccepted or unavailable. Building-year proxies do not measure roof age;
            incomplete permit history may omit a later replacement.
          </p>
        ) : null}
        {!meta && !metaError ? <SkeletonRows rows={4} /> : null}
        {run ? (
          <div className="kv-list">
            <Kv label="Run id" value={run.runId} onCopy={copy} copied={copied} />
            <Kv label="Root CID" value={run.rootCid} onCopy={copy} copied={copied} mono />
            <Kv label="Manifest CID" value={manifestCid} onCopy={copy} copied={copied} mono />
            <Kv label="CAR CID" value={carCid} onCopy={copy} copied={copied} mono />
            {publicationEvidence ? (
              <>
                {manifestCid === publicationEvidence.manifestCid ? (
                  <Kv label="Manifest SHA-256" value={publicationEvidence.manifestSha256} mono />
                ) : null}
                <Kv
                  label="Artifacts in manifest"
                  value={formatCount(publicationEvidence.artifactCount)}
                />
                {carCid === publicationEvidence.carCid ? (
                  <>
                    <Kv
                      label="CAR size"
                      value={`${formatCount(publicationEvidence.carBytes)} bytes`}
                    />
                    <Kv label="CAR SHA-256" value={publicationEvidence.carSha256} mono />
                  </>
                ) : null}
                <Kv label="Evidence recorded" value={publicationEvidence.recordedAt} mono />
              </>
            ) : null}
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
              value={verifiedGateways.length > 0 ? verifiedGateways.join(", ") : null}
              note={
                verifiedGateways.some((gateway) => /ipfs\.io|dweb\.link/.test(gateway))
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
        {publicationEvidence ? (
          <p className="notice gated">
            {publicationEvidence.scope === "finalized-publication-receipt" &&
            publicationEvidence.retentionVerified &&
            publicationEvidence.publicationPromoted
              ? "Finalized publication receipts bind this snapshot to independent retention and public gateway byte matches. They do not establish county completeness or accepted current permit status."
              : "Recorded public gateway byte matches only. Independent retention remains unverified; this evidence does not promote the run to a finalized release or change IPNS/latest."}
          </p>
        ) : null}
      </Panel>

      <Panel
        title="Run history"
        subtitle="Retained publication entries with immutable CIDs and recorded deltas. A selected partial snapshot is not automatically added to publication history or made the latest release."
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
                  <th>Table</th>
                  <th className="num">Rows</th>
                  <th className="num">Inserted</th>
                  <th className="num">Updated</th>
                  <th className="num">Unchanged</th>
                  <th className="num">Removed</th>
                </tr>
              </thead>
              <tbody>
                {[...runHistory.runs]
                  .sort((a, b) => b.runId.localeCompare(a.runId))
                  .flatMap((entry) =>
                    (entry.tables?.length ? entry.tables : [null]).map((table, index) => (
                      <tr key={`${entry.runId}:${table?.name ?? "unknown"}:${index}`}>
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
                        <td>{table?.name ?? "unknown"}</td>
                        <td className="num">{formatCount(table?.rows)}</td>
                        <td className="num">{formatCount(table?.inserted)}</td>
                        <td className="num">{formatCount(table?.updated)}</td>
                        <td className="num">{formatCount(table?.unchanged)}</td>
                        <td className="num">{formatCount(table?.removed)}</td>
                      </tr>
                    )),
                  )}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel
        title="Independent gateway verification"
        subtitle="A report, when present, records public CID retrieval and byte/digest matches. Missing evidence makes no verification or independent-retention claim."
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
            const fullPermitCounts = typeof stats.data?.stats.permit_records_total === "number";
            const legacyPermits = tile.key === "permit_records" && !fullPermitCounts;
            const permitRecordMetric = tile.key.includes("permit_records");
            const share =
              !permitRecordMetric &&
              total > 0 &&
              typeof value === "number" &&
              tile.key !== "properties"
                ? `${formatPercent(value, total)} of parcels`
                : undefined;
            return (
              <StatTile
                key={tile.key}
                label={
                  evidenceOnly && tile.key === "roof_age_known"
                    ? "Built-year roof-age proxies"
                    : evidenceOnly && tile.key === "roof_age_15_plus"
                      ? "Built-year proxies 15+ years"
                      : legacyPermits
                        ? "Linked permit records (legacy aggregate)"
                        : tile.label
                }
                loading={stats.loading && !stats.data}
                value={typeof value === "number" ? formatCount(value) : "—"}
                note={
                  legacyPermits
                    ? "property aggregate only; total and unlinked counts unavailable"
                    : (tile.note ?? share)
                }
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
        title={evidenceOnly ? "Building-year proxy bands" : "Roof age by band and basis"}
        subtitle={
          evidenceOnly
            ? "Only valid built-year anchors are accepted here, at low confidence. Completion/close anchors are not accepted; partial history may omit later reroofing. A proxy is not measured roof age."
            : "The selected run's recorded derivation basis is shown per parcel. A defensible roof reset requires accepted completed primary-roof work and a valid completion/close date; issue dates alone do not establish completion."
        }
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
        subtitle="Limitations from the coverage snapshot matching the served run. Missing coverage does not establish completeness."
      >
        {!coverage ? (
          !meta && !metaError ? (
            <SkeletonRows rows={4} height={40} />
          ) : (
            <EmptyState>
              No matching coverage snapshot supplies this run's source limitations.
            </EmptyState>
          )
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
            !meta && !metaError ? (
              <SkeletonRows rows={5} />
            ) : (
              <EmptyState>
                No coverage snapshot matches the served run. Missing coverage is not zero records.
              </EmptyState>
            )
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
                  <span className="micro">signals recorded in the frozen snapshot</span>
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
          subtitle="CID-derived retrieval locators, not independent retention proof. Per-object verification is reported separately when available."
        >
          {!meta ? (
            <SkeletonRows rows={4} />
          ) : !run || !rootCid ? (
            <EmptyState>No public root CID is recorded for these served bytes.</EmptyState>
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
                      href={gatewayUrl(gateway, rootCid, "query-table.parquet")}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {gatewayUrl(gateway, rootCid, "query-table.parquet")}
                    </a>
                    <span className="dim" style={{ fontSize: 11 }}>
                      {gateway.note}
                    </span>
                  </div>
                  {manifestCid ? (
                    <a
                      href={gatewayUrl(gateway, manifestCid)}
                      target="_blank"
                      rel="noreferrer"
                      className="btn small ghost"
                    >
                      manifest
                    </a>
                  ) : null}
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
  value: string | null | undefined;
  mono?: boolean;
  onCopy?: (text: string) => void;
  copied?: string | null;
  /** Caveat shown under the value, for a figure that needs one to be honest. */
  note?: string;
}): JSX.Element {
  const display = value == null ? "—" : mono ? shortCid(value, 14, 8) : value;
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
