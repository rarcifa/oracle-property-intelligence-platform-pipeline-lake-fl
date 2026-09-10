/**
 * The "SQL that produced this" disclosure.
 *
 * This is the app's strongest evidence that a figure was computed rather than
 * asserted, so it appears next to every result set and is one click from
 * closed. It also prints where the bytes came from - an IPFS gateway URL in
 * browser mode, the server's Parquet description otherwise - and which upstream
 * systems the columns belong to.
 */

import type { ResponseProvenance } from "@oracle-lake/shared";
import { SOURCE_SYSTEM_LABELS } from "@oracle-lake/shared";
import { shortCid } from "../lib/format.js";

export function SqlBlock({
  provenance,
  label = "SQL that produced this",
  open = false,
}: {
  provenance: ResponseProvenance | null;
  label?: string;
  open?: boolean;
}): JSX.Element | null {
  if (!provenance) return null;
  const sources = provenance.sourceSystems.map((token) => SOURCE_SYSTEM_LABELS[token] ?? token);
  return (
    <details className="sql-block" open={open}>
      <summary>{label}</summary>
      <pre>
        <code>{provenance.sql}</code>
      </pre>
      <div className="sql-meta">
        <span>
          read from <strong>{provenance.dataSource}</strong> ({provenance.dataSourceKind})
        </span>
        {provenance.runId ? <span>run {provenance.runId}</span> : null}
        {provenance.rootCid ? <span>root {shortCid(provenance.rootCid)}</span> : null}
        {sources.length > 0 ? <span>sources: {sources.join(", ")}</span> : null}
      </div>
    </details>
  );
}
