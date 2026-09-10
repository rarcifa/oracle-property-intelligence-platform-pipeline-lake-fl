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
 * Parquet with `curl -sL -r 0-1023 -H 'Origin: ...'` (2026-09-10). Six gateways
 * answer HTTP 206 with `content-range` and `access-control-allow-origin: *`:
 * filebase, pinata, ipfs-lens, ipfs.io, dweb.link and w3s.link. Only
 * `4everland.io` does not, and it is recorded rather than quietly omitted.
 *
 * The `-L` matters and the first measurement here was wrong without it: dweb.link
 * and w3s.link answer 301 to a subdomain gateway and serve the range from there,
 * so a client that follows redirects — every real one, including the kit's own
 * verifier — sees 206. An earlier note claiming filebase was the only usable
 * gateway was simply out of date.
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
  /**
   * Resolves `/ipns/<name>` as well as `/ipfs/<cid>`.
   *
   * Measured on 2026-09-10 against this project's own IPNS name: filebase
   * answers 200 with `x-ipfs-roots`; `gateway.pinata.cloud` and
   * `gw.ipfs-lens.dev` answer 403 to any `/ipns/` path — they serve CIDs only.
   * Recorded per gateway rather than assumed, because the runtime now resolves
   * the pointer live and a gateway that cannot is not a candidate.
   */
  readonly ipns: boolean;
  readonly note: string;
}

/** Gateways verified to serve this dataset. Ordered by preference. */
export const IPFS_GATEWAYS: readonly IpfsGateway[] = Object.freeze([
  Object.freeze({
    id: "filebase",
    baseUrl: "https://ipfs.filebase.io",
    cors: true,
    range: true,
    ipns: true,
    note: "CORS + HTTP Range verified. Required for browser-side DuckDB-WASM range reads.",
  }),
  Object.freeze({
    id: "pinata",
    baseUrl: "https://gateway.pinata.cloud",
    cors: true,
    range: true,
    ipns: false,
    note: "HTTP 206 + CORS measured on the published Parquet. Reachable from datacenter egress.",
  }),
  Object.freeze({
    id: "ipfs-lens",
    baseUrl: "https://gw.ipfs-lens.dev",
    cors: true,
    range: true,
    ipns: false,
    note: "HTTP 206 + CORS measured on the published Parquet. Reachable from datacenter egress.",
  }),
  Object.freeze({
    id: "ipfs.io",
    baseUrl: "https://ipfs.io",
    cors: true,
    range: true,
    datacenter429: true,
    ipns: true,
    note: "HTTP 206 + CORS measured, but rate-limits datacenter egress, so it is ordered last.",
  }),
  Object.freeze({
    id: "dweb.link",
    baseUrl: "https://dweb.link",
    cors: true,
    range: true,
    datacenter429: true,
    ipns: true,
    note: "301 to a subdomain gateway, then 206 + CORS. Rate-limits datacenter egress.",
  }),
  Object.freeze({
    id: "w3s.link",
    baseUrl: "https://w3s.link",
    cors: true,
    range: true,
    datacenter429: true,
    ipns: true,
    note: "301 to a subdomain gateway, then 206 + CORS. Rate-limits datacenter egress.",
  }),
]);

/** Gateways that cannot serve a range read here. Recorded, not omitted. */
export const UNUSABLE_IPFS_GATEWAYS: readonly { host: string; reason: string }[] = Object.freeze([
  Object.freeze({
    host: "4everland.io",
    reason: "HTTP 301 that does not resolve to the bytes, even following redirects",
  }),
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

/**
 * Every gateway that can resolve an IPNS name, most preferred first.
 *
 * The published dataset moves: each run pins a new immutable root and re-points
 * one IPNS name at it. A consumer that wants the newest run has to resolve the
 * name, and only some gateways will. Ordered like the range-read list, so a
 * gateway that rate-limits datacenter egress is asked last.
 */
export const IPNS_GATEWAYS: readonly IpfsGateway[] = Object.freeze(
  IPFS_GATEWAYS.filter((gateway) => gateway.ipns).sort(
    (a, b) => Number(a.datacenter429 ?? false) - Number(b.datacenter429 ?? false),
  ),
);

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

/** Build a gateway URL for `/ipns/<name>/<path>`. */
export function ipnsUrl(gateway: IpfsGateway | string, name: string, path = ""): string {
  const base = (typeof gateway === "string" ? gateway : gateway.baseUrl).replace(/\/+$/, "");
  const trimmedPath = path.replace(/^\/+/, "");
  return trimmedPath.length > 0 ? `${base}/ipns/${name}/${trimmedPath}` : `${base}/ipns/${name}`;
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
