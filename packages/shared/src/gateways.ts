/**
 * Public IPFS gateways, and how to build a read URL for a published run.
 *
 * Gateway choice is not cosmetic. `ipfs.io`, `dweb.link` and `w3s.link` answer
 * HTTP 429 to datacenter egress (measured, including GitHub runners), so they
 * are recorded here as known-bad rather than being quietly omitted.
 * `ipfs.filebase.io` is the only gateway measured to support both CORS and
 * HTTP Range, which is what a browser DuckDB-WASM range read needs.
 */

export interface IpfsGateway {
  readonly id: string;
  readonly baseUrl: string;
  /** Sends permissive CORS headers, so a browser can read it directly. */
  readonly cors: boolean;
  /** Honours HTTP Range requests, so DuckDB can read Parquet footers. */
  readonly range: boolean;
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
    range: false,
    note: "Verified reachable from datacenter egress. Used for JSON artifacts.",
  }),
  Object.freeze({
    id: "ipfs-lens",
    baseUrl: "https://gw.ipfs-lens.dev",
    cors: true,
    range: false,
    note: "Verified reachable from datacenter egress. Used for JSON artifacts.",
  }),
]);

/** Gateways that answer 429 to datacenter egress. Never used by this app. */
export const UNUSABLE_IPFS_GATEWAYS: readonly { host: string; reason: string }[] = Object.freeze([
  Object.freeze({ host: "ipfs.io", reason: "HTTP 429 to datacenter egress" }),
  Object.freeze({ host: "dweb.link", reason: "HTTP 429 to datacenter egress" }),
  Object.freeze({ host: "w3s.link", reason: "HTTP 429 to datacenter egress" }),
]);

/** The gateway used for Parquet range reads. */
export const RANGE_READ_GATEWAY: IpfsGateway = IPFS_GATEWAYS[0]!;

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

/** The Parquet URL a browser should range-read for a published run root CID. */
export function parquetUrl(rootCid: string): string {
  return gatewayUrl(RANGE_READ_GATEWAY, rootCid, "query-table.parquet");
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
