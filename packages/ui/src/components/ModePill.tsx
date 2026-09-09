/**
 * The header pill that says which engine answered the last query.
 *
 * Green means the tab itself is running DuckDB-WASM and range-reading the
 * published Parquet from IPFS; amber means the REST server is answering. The
 * expander explains what that difference means for the cost of running this
 * app, and offers the manual switch, because a reviewer should be able to force
 * either path and watch the numbers stay identical.
 */

import { useEffect, useRef, useState } from "react";
import { useDataSource } from "../data/DataSourceProvider.js";

const CLAIM =
  "When the browser reads the Parquet directly from IPFS by CID, serving this app costs nothing beyond static hosting: no database, no query service, no ongoing infrastructure.";

export function ModePill(): JSX.Element {
  const { mode, reason, source, retryBrowser, forceServer } = useDataSource();
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDocumentClick = (event: MouseEvent): void => {
      if (
        wrapper.current &&
        event.target instanceof Node &&
        !wrapper.current.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocumentClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocumentClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const text =
    mode === "browser"
      ? "Browser DuckDB-WASM · range-reading IPFS"
      : mode === "server"
        ? "Server DuckDB"
        : "Connecting to the published run…";

  return (
    <div ref={wrapper} style={{ position: "relative" }}>
      <button
        type="button"
        className={`mode-pill ${mode}`}
        aria-expanded={open}
        aria-label={`Data path: ${text}. Show details.`}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="dot" />
        {text}
        <span aria-hidden="true" style={{ opacity: 0.6 }}>
          {open ? "▾" : "▸"}
        </span>
      </button>

      {open ? (
        <div className="mode-details">
          <span className="micro">Where this answer is computed</span>
          <p className="claim" style={{ marginTop: 6 }}>
            {mode === "browser"
              ? "This tab is running DuckDB in WebAssembly and issuing HTTP Range requests against the published Parquet on IPFS. Only the file footer and the row groups a query touches cross the network."
              : "Queries are running on the server's DuckDB over the same published Parquet, using the same generated SQL."}
          </p>
          <p style={{ fontSize: 12.5 }}>{CLAIM}</p>
          <div className="kv" style={{ borderBottom: 0 }}>
            <span>Reading</span>
            <span>{source.dataSource}</span>
          </div>
          {reason ? (
            <p className="muted" style={{ fontSize: 12 }}>
              {reason}
            </p>
          ) : null}
          <div className="mode-actions">
            <button
              type="button"
              className="btn small"
              onClick={() => {
                retryBrowser();
                setOpen(false);
              }}
              disabled={mode === "connecting"}
            >
              Use browser DuckDB-WASM
            </button>
            <button
              type="button"
              className="btn small ghost"
              onClick={() => {
                forceServer();
                setOpen(false);
              }}
              disabled={mode === "connecting"}
            >
              Use server DuckDB
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
