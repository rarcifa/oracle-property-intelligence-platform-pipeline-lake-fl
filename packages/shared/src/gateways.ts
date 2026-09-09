/**
 * Public IPFS gateways, and how to build a read URL for a published run.
 *
 * Gateway choice is not cosmetic. The read path used to pin `ipfs.filebase.io`
 * alone — the same vendor that pins the data — which put the runtime in tension
 * with this project's own rule that a vendor-specific HTTP URL is never the
 * source of truth, and made the no-ongoing-cost claim depend on one account
 * staying live. The CID is the source of truth; a gateway is transport, and
 * transport is allowed to fail, so the read path now falls over between them.
 *
 * `cors` and `range` are measured, not assumed, against the published 20 MB
 * Parquet with `curl -r 0-1023 -H 'Origin: ...'` (2026-09-10): filebase, pinata,
 * ipfs-lens and ipfs.io each answered HTTP 206 with `content-range` and
 * `access-control-allow-origin: *`. An earlier note here claimed filebase was
 * the only one; it was out of date. `dweb.link`, `w3s.link` and `4everland.io`
 * answered 301 and are recorded as unusable rather than quietly omitted.
 *
 * `datacenter429` marks a gateway that rate-limits datacenter egress. Those are
 * kept — a browser reads from a residential address and they work there — but
 * ordered last, because the Lambda reads from a datacenter.
 */

export interface IpfsGateway {
  readonly id: string;
  readonly baseUrl: string;
  /** Sends permissive CORS headers, so a browser can read it directly. */
  readonly cors: boolean;
  /** Honours HTTP Range requests, so DuckDB can read Parquet footers. */
  readonly range: boolean;
  /** Rate-limits datacenter egress, so it is a poor first choice server-side. */
  readonly datacenter429?: boolean;
  readonly note: string;
}

/** Gateways verified to serve this dataset. Ordered by preference. */
export const IPFS_GATEWAYS: readonly IpfsGateway[] = Object.freeze([
  Object.freeze({
    id: "filebase",
    baseUrl: "https://ipfs.filebase.io",
    cors: true,
    range: true,
    note: "CORS + HTTP Range verified. Required for browser-side DuckDB-WASM range reads.",
  }),
  Object.freeze({
    id: "pinata",
    baseUrl: "https://gateway.pinata.cloud",
    cors: true,
    range: true,
    note: "HTTP 206 + CORS measured on the published Parquet. Reachable from datacenter egress.",
  }),
  Object.freeze({
    id: "ipfs-lens",
    baseUrl: "https://gw.ipfs-lens.dev",
    cors: true,
    range: true,
    note: "HTTP 206 + CORS measured on the published Parquet. Reachable from datacenter egress.",
  }),
  Object.freeze({
    id: "ipfs.io",
    baseUrl: "https://ipfs.io",
    cors: true,
    range: true,
    datacenter429: true,
    note: "HTTP 206 + CORS measured, but rate-limits datacenter egress, so it is ordered last.",
  }),
]);

/** Gateways that cannot serve a range read here. Recorded, not omitted. */
export const UNUSABLE_IPFS_GATEWAYS: readonly { host: string; reason: string }[] = Object.freeze([
  Object.freeze({ host: "dweb.link", reason: "HTTP 301 on the published Parquet path" }),
  Object.freeze({ host: "w3s.link", reason: "HTTP 301, and no CORS header" }),
  Object.freeze({ host: "4everland.io", reason: "HTTP 301 on the published Parquet path" }),
]);

/**
 * Every gateway a Parquet range read may use, most preferred first.
 *
 * Ordered so a gateway that rate-limits datacenter egress comes last: the
 * browser can use it, the Lambda mostly cannot, and one ordering serves both.
 */
export const RANGE_READ_GATEWAYS: readonly IpfsGateway[] = Object.freeze(
  IPFS_GATEWAYS.filter((gateway) => gateway.cors && gateway.range).sort(
    (a, b) => Number(a.datacenter429 ?? false) - Number(b.datacenter429 ?? false),
  ),
);

/** The first-choice gateway for Parquet range reads. */
export const RANGE_READ_GATEWAY: IpfsGateway = RANGE_READ_GATEWAYS[0]!;

/** Build a gateway URL for `<cid>/<path>`. `path` may be empty for a bare CID. */
export function gatewayUrl(gateway: IpfsGateway | string, cid: string, path = ""): string {
  const base = typeof gateway === "string" ? gateway : gateway.baseUrl;
  const trimmedBase = base.replace(/\/+$/, "");
  const trimmedPath = path.replace(/^\/+/, "");
  return trimmedPath.length > 0
    ? `${trimmedBase}/ipfs/${cid}/${trimmedPath}`
    : `${trimmedBase}/ipfs/${cid}`;
}

/** Every candidate URL for one artifact, most preferred first. */
export function gatewayUrls(cid: string, path = ""): string[] {
  return IPFS_GATEWAYS.map((gateway) => gatewayUrl(gateway, cid, path));
}

/** The first-choice Parquet URL for a published run root CID. */
export function parquetUrl(rootCid: string): string {
  return gatewayUrl(RANGE_READ_GATEWAY, rootCid, "query-table.parquet");
}

/**
 * Every Parquet URL worth trying for a run, most preferred first.
 *
 * `preferred` (an operator override, or whatever the server was configured
 * with) is tried first and then de-duplicated, so configuring a gateway keeps
 * the fallbacks rather than replacing them.
 */
export function parquetCandidates(rootCid: string, preferred?: string | null): string[] {
  const candidates = RANGE_READ_GATEWAYS.map((gateway) =>
    gatewayUrl(gateway, rootCid, "query-table.parquet"),
  );
  const ordered = preferred ? [preferred, ...candidates] : candidates;
  return [...new Set(ordered)];
}

/** The registered gateway serving a URL, or null when it is from none of them. */
export function gatewayOf(url: string): IpfsGateway | null {
  return IPFS_GATEWAYS.find((gateway) => url.startsWith(`${gateway.baseUrl}/`)) ?? null;
}

/** The published-run pointer written by the publish step. */
export interface LatestRunPointer {
  runId: string;
  rootCid: string;
  manifestCid: string;
  carCid: string | null;
  ipnsName: string | null;
  resolvedCid: string | null;
  verifiedGateways: string[];
  propertyCount: number;
}
