/**
 * Chooses, exposes and can switch the active data path.
 *
 * On load the provider asks the server for the published run pointer. If that
 * run has a root CID and the viewer has not pinned the server path, it boots
 * DuckDB-WASM and range-reads the Parquet from IPFS in the tab. Anything that
 * goes wrong there - no CID, a gateway that will not serve Range, a schema that
 * does not match the published columns, a slow cold start - fails over to the
 * REST API and records the reason, which the header pill shows verbatim.
 *
 * The manual choice is persisted in `localStorage`, guarded because private
 * windows and blocked site data make every access throwable.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { createApiSource } from "./apiSource.js";
import type { BrowserDataSource } from "./duckdbSource.js";
import { errorText, getJson } from "./http.js";
import type { DataSource, RunMetaResponse } from "./types.js";

/** Which implementation is answering right now. */
export type DataMode = "browser" | "server" | "connecting";

export interface DataSourceContextValue {
  mode: DataMode;
  source: DataSource;
  /** Why the current mode was chosen. Always populated for `server`. */
  reason: string | null;
  retryBrowser(): void;
  forceServer(): void;
  /** The published run pointer and coverage snapshot, shared by every view. */
  meta: RunMetaResponse | null;
  metaError: { message: string; detail: string | null } | null;
}

const STORAGE_KEY = "oracle-lake.data-mode";

/** Used until the server has described its own Parquet location. */
const BOOTSTRAP_SOURCE = createApiSource("server");

const DataSourceContext = createContext<DataSourceContextValue | null>(null);

function readPreference(): "browser" | "server" | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === "browser" || stored === "server" ? stored : null;
  } catch {
    return null;
  }
}

function writePreference(value: "browser" | "server" | null): void {
  try {
    if (value === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Storage unavailable: the choice simply does not survive a reload.
  }
}

export function DataSourceProvider({ children }: { children: ReactNode }): JSX.Element {
  const [mode, setMode] = useState<DataMode>("connecting");
  const [source, setSource] = useState<DataSource>(BOOTSTRAP_SOURCE);
  const [reason, setReason] = useState<string | null>(null);
  const [meta, setMeta] = useState<RunMetaResponse | null>(null);
  const [metaError, setMetaError] = useState<{ message: string; detail: string | null } | null>(
    null,
  );
  const [attempt, setAttempt] = useState(0);

  const browserRef = useRef<BrowserDataSource | null>(null);
  const generationRef = useRef(0);

  const disposeBrowser = useCallback(() => {
    const existing = browserRef.current;
    browserRef.current = null;
    if (existing) void existing.close();
  }, []);

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const current = (): boolean => generationRef.current === generation;

    const connect = async (): Promise<void> => {
      setMode("connecting");
      setMetaError(null);

      let runMeta: RunMetaResponse;
      try {
        runMeta = await getJson<RunMetaResponse>("/api/meta/run");
      } catch (error) {
        if (!current()) return;
        const text = errorText(error);
        setMetaError(text);
        setSource(BOOTSTRAP_SOURCE);
        setMode("server");
        setReason(`Could not read the published run pointer: ${text.message}`);
        return;
      }
      if (!current()) return;

      setMeta(runMeta);
      const api = createApiSource(runMeta.dataSource);
      setSource(api);

      const preference = readPreference();
      if (preference === "server") {
        disposeBrowser();
        setMode("server");
        setReason("Server data path pinned for this browser. Switch back at any time.");
        return;
      }

      const rootCid = runMeta.run?.rootCid ?? null;
      if (!rootCid) {
        disposeBrowser();
        setMode("server");
        setReason(
          "No published root CID in the run pointer, so there is no immutable Parquet to range-read.",
        );
        return;
      }

      try {
        // Imported on demand so the DuckDB-WASM bootstrap and Arrow decoder are
        // not in the first paint's critical path.
        const { createDuckDbSource } = await import("./duckdbSource.js");
        const browser = await createDuckDbSource({
          rootCid,
          runId: runMeta.run?.runId ?? null,
        });
        if (!current()) {
          void browser.close();
          return;
        }
        disposeBrowser();
        browserRef.current = browser;
        setSource(browser);
        setMode("browser");
        setReason(null);
      } catch (error) {
        if (!current()) return;
        const text = errorText(error);
        setSource(api);
        setMode("server");
        setReason(`Browser DuckDB-WASM unavailable: ${text.message}`);
      }
    };

    void connect();

    return () => {
      generationRef.current += 1;
    };
  }, [attempt, disposeBrowser]);

  useEffect(() => disposeBrowser, [disposeBrowser]);

  const retryBrowser = useCallback(() => {
    writePreference(null);
    disposeBrowser();
    setAttempt((value) => value + 1);
  }, [disposeBrowser]);

  const forceServer = useCallback(() => {
    writePreference("server");
    disposeBrowser();
    setAttempt((value) => value + 1);
  }, [disposeBrowser]);

  const value = useMemo<DataSourceContextValue>(
    () => ({ mode, source, reason, retryBrowser, forceServer, meta, metaError }),
    [mode, source, reason, retryBrowser, forceServer, meta, metaError],
  );

  return <DataSourceContext.Provider value={value}>{children}</DataSourceContext.Provider>;
}

/** Read the active data source. Throws when used outside the provider. */
export function useDataSource(): DataSourceContextValue {
  const value = useContext(DataSourceContext);
  if (!value) throw new Error("useDataSource must be used inside <DataSourceProvider>");
  return value;
}
