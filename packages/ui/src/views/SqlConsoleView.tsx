/**
 * SQL console: run a read-only query against the published table.
 *
 * This exists to make the read-only guard visible. `assertReadOnlySql` in the
 * shared package rejects anything that is not a single SELECT/WITH, and the
 * console prints the rejection text rather than swallowing it - there is a
 * button that deliberately triggers one.
 *
 * In browser mode the query runs in this tab against the Parquet on IPFS; in
 * server mode it goes to `POST /api/sql`. Same SQL, same table.
 */

import { useState } from "react";
import { DEFAULT_ROOF_AGE_THRESHOLD_YEARS, PROPERTIES_VIEW } from "@oracle-lake/shared";
import { EmptyState, ErrorPanel, Panel } from "../components/Primitives.js";
import { SqlBlock } from "../components/SqlBlock.js";
import { useDataSource } from "../data/DataSourceProvider.js";
import { errorText } from "../data/http.js";
import type { SqlResponse } from "../data/types.js";
import { formatCount } from "../lib/format.js";
import { cellText } from "../lib/rows.js";

const EXAMPLE_SQL = `SELECT
  address_city,
  count(*) AS parcels,
  count(*) FILTER (WHERE roof_age_years >= ${DEFAULT_ROOF_AGE_THRESHOLD_YEARS}) AS aged_roofs
FROM ${PROPERTIES_VIEW}
WHERE address_city IS NOT NULL
GROUP BY 1
ORDER BY aged_roofs DESC
LIMIT 20`;

const REJECTED_SQL = `DROP TABLE ${PROPERTIES_VIEW}`;

export function SqlConsoleView(): JSX.Element {
  const { source, mode } = useDataSource();
  const [sql, setSql] = useState(EXAMPLE_SQL);
  const [result, setResult] = useState<SqlResponse | null>(null);
  const [error, setError] = useState<{ message: string; detail: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (statement: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const response = await source.runSql(statement, 200);
      setResult(response);
    } catch (thrown) {
      setError(errorText(thrown));
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  const columns = result && result.rows.length > 0 ? Object.keys(result.rows[0] ?? {}) : [];

  return (
    <div className="stack">
      <Panel
        title="Read-only SQL console"
        subtitle={
          <>
            The published table is exposed as the view <code>{PROPERTIES_VIEW}</code>. Only a single
            SELECT or WITH statement is accepted; everything else is rejected before it reaches
            DuckDB.
          </>
        }
        actions={
          <span className="micro">
            running {mode === "browser" ? "in this browser" : "on the server"}
          </span>
        }
      >
        <div className="field">
          <label htmlFor="sql-input">Statement</label>
          <textarea
            id="sql-input"
            className="mono"
            rows={10}
            value={sql}
            onChange={(event) => setSql(event.target.value)}
            spellCheck={false}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void run(sql);
              }
            }}
          />
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button
            type="button"
            className="btn primary"
            onClick={() => void run(sql)}
            disabled={busy}
          >
            {busy ? "Running…" : "Run query"}
          </button>
          <button
            type="button"
            className="btn ghost"
            onClick={() => setSql(EXAMPLE_SQL)}
            disabled={busy}
          >
            Reset to example
          </button>
          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              setSql(REJECTED_SQL);
              void run(REJECTED_SQL);
            }}
            disabled={busy}
            title="Demonstrates the read-only guard"
          >
            Try a rejected statement
          </button>
          <span className="dim" style={{ fontSize: 11.5 }}>
            Cmd/Ctrl + Enter to run
          </span>
        </div>

        {busy ? (
          <div style={{ marginTop: 12 }}>
            <div className="progress-line" />
          </div>
        ) : null}
        {error ? (
          <div style={{ marginTop: 12 }}>
            <ErrorPanel error={error} />
          </div>
        ) : null}
      </Panel>

      {result ? (
        <Panel
          title="Result"
          subtitle={`${formatCount(result.rowCount)} row(s) returned${result.truncated ? " · truncated, add a LIMIT or count(*) for the total" : ""}`}
        >
          {result.rows.length === 0 ? (
            <EmptyState>The query returned no rows.</EmptyState>
          ) : (
            <div className="table-scroll">
              <table className="data" style={{ minWidth: Math.max(480, columns.length * 150) }}>
                <thead>
                  <tr>
                    {columns.map((column) => (
                      <th key={column} scope="col">
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, index) => (
                    <tr key={index}>
                      {columns.map((column) => (
                        <td key={column} className="mono">
                          {cellText(row[column])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div style={{ marginTop: 12 }}>
            <SqlBlock provenance={result.provenance} label="Statement executed" />
          </div>
        </Panel>
      ) : null}
    </div>
  );
}
