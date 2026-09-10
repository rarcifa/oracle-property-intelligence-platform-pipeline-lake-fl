/**
 * A hash router in about forty lines, so the app ships no routing dependency.
 *
 * Routes are `#/overview`, `#/search`, `#/property/<parcelId>`, `#/tenant`,
 * `#/business`, `#/contractor`, `#/ask` and `#/sql`. The parcel id is percent-
 * encoded on the way in and decoded on the way out, because Lake County parcel
 * ids contain characters that are legal but ugly in a fragment.
 */

import { useCallback, useEffect, useState } from "react";

export interface Route {
  /** Path without the leading `#`, e.g. `/property/05-18-25-0004-000-00400`. */
  path: string;
  /** Path split on `/`, empty segments removed. */
  segments: string[];
}

const DEFAULT_PATH = "/overview";

function currentPath(): string {
  const raw = window.location.hash.replace(/^#/, "");
  return raw.length > 0 ? raw : DEFAULT_PATH;
}

function toRoute(path: string): Route {
  return {
    path,
    segments: path
      .split("/")
      .filter((segment) => segment.length > 0)
      .map(decodeURIComponent),
  };
}

/** Navigate to a hash route. */
export function navigate(path: string): void {
  const next = path.startsWith("/") ? path : `/${path}`;
  if (window.location.hash.replace(/^#/, "") === next) return;
  window.location.hash = next;
}

/** Build the route for one parcel's detail page. */
export function propertyPath(parcelId: string): string {
  return `/property/${encodeURIComponent(parcelId)}`;
}

/** Subscribe to the current hash route. */
export function useHashRoute(): Route {
  const [path, setPath] = useState<string>(() => currentPath());

  const sync = useCallback(() => setPath(currentPath()), []);

  useEffect(() => {
    if (window.location.hash.length === 0) window.location.hash = DEFAULT_PATH;
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [sync]);

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [path]);

  return toRoute(path);
}
