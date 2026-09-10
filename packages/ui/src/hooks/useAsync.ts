/**
 * Run an async loader and expose `{ data, loading, error, reload }`.
 *
 * Results from a superseded run are discarded by generation counter rather than
 * `AbortController`, because the browser data source runs local DuckDB queries
 * that have nothing to abort. Errors keep the server's own `error`/`detail`
 * text so views can print it verbatim.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { errorText } from "../data/http.js";

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: { message: string; detail: string | null } | null;
  reload: () => void;
}

export function useAsync<T>(loader: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; detail: string | null } | null>(null);
  const [nonce, setNonce] = useState(0);

  const generation = useRef(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    const mine = generation.current + 1;
    generation.current = mine;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const result = await loaderRef.current();
        if (generation.current !== mine) return;
        setData(result);
        setLoading(false);
      } catch (thrown) {
        if (generation.current !== mine) return;
        setError(errorText(thrown));
        setData(null);
        setLoading(false);
      }
    })();

    return () => {
      generation.current += 1;
    };
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  return { data, loading, error, reload };
}
