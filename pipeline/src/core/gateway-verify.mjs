/**
 * Independent retrievability proof for published CIDs.
 *
 * Uploading to a pinning provider proves nothing: the provider can serve the
 * bytes from its own store whether or not the DAG was ever announced to the
 * network. A publication is only honest once an unrelated gateway hands back
 * the same bytes, so this module fetches `<gateway>/ipfs/<cid>` from several
 * gateways and compares the response against the size and sha2-256 recorded in
 * the artifact manifest. Both must match: a truncated or substituted response
 * frequently has a plausible length, and only the digest catches it.
 *
 * Gateway behaviour is uneven and that is treated as expected, not as failure.
 * `ipfs.io`, `dweb.link` and `w3s.link` return HTTP 429 to datacenter and VPN
 * egress, which includes CI runners, so they are listed last and are never
 * required for a pass; `gateway.pinata.cloud` and `gw.ipfs-lens.dev` are the
 * ones observed to answer. Requests are issued one at a time with a delay so a
 * verification pass never looks like a burst.
 *
 * @module core/gateway-verify
 */

import { createHash } from "node:crypto";

import { validateArtifactManifest } from "./artifact-manifest.mjs";

/**
 * Ordered gateways. The two known-good hosts come first so a pass is normally
 * reached before the rate-limiting hosts are ever asked.
 */
/**
 * Ordered by measured reliability, fastest and most dependable first. This
 * order matters because verification stops as soon as enough independent
 * gateways agree: putting a slow gateway first makes every artifact wait on
 * it. Measured on a 20 MB Parquet: filebase 2.6 s, ipfs-lens 6.0 s, and
 * pinata truncated the response at 494 KB after 29.8 s. `ipfs.io` and
 * `dweb.link` are kept last because they return HTTP 429 to datacenter and
 * VPN egress; they are never required for a pass.
 */
export const DEFAULT_GATEWAYS = Object.freeze([
  "https://ipfs.filebase.io",
  "https://gw.ipfs-lens.dev",
  "https://gateway.pinata.cloud",
  "https://ipfs.io",
  "https://dweb.link",
]);

/** Gentle defaults: sequential gateways, one artifact at a time. */
export const DEFAULT_GATEWAY_DELAY_MS = 1500;
/** Default number of distinct gateways that must return matching bytes. */
export const DEFAULT_MINIMUM_INDEPENDENT_GATEWAYS = 2;
/** Default per-request timeout. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/**
 * @param {number} ms milliseconds to wait
 * @returns {Promise<void>}
 */
function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Normalize a gateway base URL and derive the host used to decide whether two
 * successes are actually independent.
 *
 * @param {string} gateway gateway base URL
 * @returns {{ base: string, host: string }}
 */
function normalizeGateway(gateway) {
  if (typeof gateway !== "string" || gateway.trim().length === 0) {
    throw new TypeError("gateway must be a non-empty URL string");
  }
  const base = gateway.trim().replace(/\/+$/, "");
  return { base, host: new URL(base).host.toLowerCase() };
}

/**
 * Fetch one CID from one gateway and compare it with the expected integrity.
 *
 * @param {{
 *   cid: string,
 *   gateway: string,
 *   expectedSize: number,
 *   expectedSha256: string,
 *   fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
 *   timeoutMs: number
 * }} options single-request inputs
 * @returns {Promise<{ gateway: string, ok: boolean, status: number | null, bytes: number | null, sha256: string | null, error: string | null }>}
 */
async function fetchFromGateway({
  cid,
  gateway,
  expectedSize,
  expectedSha256,
  fetchImpl,
  timeoutMs,
}) {
  const { base } = normalizeGateway(gateway);
  try {
    const response = await fetchImpl(`${base}/ipfs/${cid}`, {
      redirect: "follow",
      headers: { Accept: "*/*" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const status =
      typeof response?.status === "number" ? response.status : null;
    if (status !== 200) {
      return {
        gateway: base,
        ok: false,
        status,
        bytes: null,
        sha256: null,
        error: `HTTP ${String(status)}`,
      };
    }
    const body = Buffer.from(await response.arrayBuffer());
    const sha256 = `sha256:${createHash("sha256").update(body).digest("hex")}`;
    const sizeMatches = body.length === expectedSize;
    const digestMatches = sha256 === expectedSha256;
    return {
      gateway: base,
      ok: sizeMatches && digestMatches,
      status,
      bytes: body.length,
      sha256,
      error:
        sizeMatches && digestMatches
          ? null
          : `expected ${expectedSize} bytes ${expectedSha256}, received ${body.length} bytes ${sha256}`,
    };
  } catch (error) {
    return {
      gateway: base,
      ok: false,
      status: null,
      bytes: null,
      sha256: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Verify that one CID is retrievable, byte for byte, from several independent
 * public gateways.
 *
 * Every gateway in the list is asked, in order, with a delay between requests;
 * individual failures (429, timeout, 404) are recorded and never abort the
 * pass. `verified` is true only when at least `minimumIndependentGateways`
 * distinct gateway hosts returned bytes matching BOTH the expected length and
 * the expected digest.
 *
 * @param {{
 *   cid: string,
 *   expectedSize: number,
 *   expectedSha256: string,
 *   gateways?: string[],
 *   minimumIndependentGateways?: number,
 *   fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>,
 *   delayMs?: number,
 *   timeoutMs?: number,
 *   sleep?: (ms: number) => Promise<void>
 * }} options the artifact to check and how gently to check it
 * @returns {Promise<{ cid: string, verified: boolean, matchedGateways: string[], minimumIndependentGateways: number, results: Array<{ gateway: string, ok: boolean, status: number | null, bytes: number | null, sha256: string | null, error: string | null }> }>}
 */
export async function verifyArtifactAcrossGateways({
  cid,
  expectedSize,
  expectedSha256,
  gateways = DEFAULT_GATEWAYS,
  minimumIndependentGateways = DEFAULT_MINIMUM_INDEPENDENT_GATEWAYS,
  fetchImpl = fetch,
  delayMs = DEFAULT_GATEWAY_DELAY_MS,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  sleep = defaultSleep,
}) {
  if (typeof cid !== "string" || cid.length === 0) {
    throw new TypeError("cid is required");
  }
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) {
    throw new TypeError("expectedSize must be a non-negative safe integer");
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(String(expectedSha256))) {
    throw new TypeError("expectedSha256 must be a sha256:<64-hex> digest");
  }
  if (!Array.isArray(gateways) || gateways.length === 0) {
    throw new TypeError("gateways must be a non-empty array");
  }
  if (
    !Number.isSafeInteger(minimumIndependentGateways) ||
    minimumIndependentGateways < 1
  ) {
    throw new TypeError(
      "minimumIndependentGateways must be a positive integer",
    );
  }
  const results = [];
  const matchedHosts = new Set();
  const matchedGateways = [];
  for (const [index, gateway] of gateways.entries()) {
    if (index > 0 && delayMs > 0) await sleep(delayMs);
    const result = await fetchFromGateway({
      cid,
      gateway,
      expectedSize,
      expectedSha256,
      fetchImpl,
      timeoutMs,
    });
    results.push(result);
    if (!result.ok) continue;
    const { host } = normalizeGateway(result.gateway);
    if (matchedHosts.has(host)) continue;
    matchedHosts.add(host);
    matchedGateways.push(result.gateway);
    // Stop once enough independent gateways agree. The requirement is
    // retrieval from at least two gateways this environment does not operate,
    // and continuing past that spends minutes re-downloading the same bytes
    // from slower gateways without strengthening the evidence.
    if (matchedHosts.size >= minimumIndependentGateways) break;
  }
  return {
    cid,
    verified: matchedHosts.size >= minimumIndependentGateways,
    matchedGateways,
    minimumIndependentGateways,
    results,
  };
}

/**
 * Verify every file entry of an artifact manifest across gateways.
 *
 * Directory entries are skipped because a directory CID does not address a
 * byte string that can be digested; the files inside it are what get checked,
 * and the CAR of the root is itself listed as a file entry.
 *
 * @param {{
 *   manifest: unknown,
 *   gateways?: string[],
 *   minimumIndependentGateways?: number,
 *   fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>,
 *   delayMs?: number,
 *   timeoutMs?: number,
 *   concurrency?: number,
 *   sleep?: (ms: number) => Promise<void>
 * }} options the manifest to prove and how gently to prove it
 * @returns {Promise<{
 *   runId: string,
 *   county: string,
 *   verified: boolean,
 *   checkedArtifacts: number,
 *   verifiedArtifacts: number,
 *   minimumIndependentGateways: number,
 *   gateways: string[],
 *   artifacts: Array<{ name: string, cid: string, verified: boolean, matchedGateways: string[], results: Array<Record<string, unknown>> }>
 * }>}
 */
export async function verifyManifestAcrossGateways({
  manifest,
  gateways = DEFAULT_GATEWAYS,
  minimumIndependentGateways = DEFAULT_MINIMUM_INDEPENDENT_GATEWAYS,
  fetchImpl = fetch,
  delayMs = DEFAULT_GATEWAY_DELAY_MS,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  concurrency = 1,
  sleep = defaultSleep,
}) {
  const validated = validateArtifactManifest(manifest);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new TypeError("concurrency must be a positive integer");
  }
  const files = validated.artifacts.filter(
    (artifact) => artifact.codec === "file",
  );
  const artifacts = new Array(files.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= files.length) return;
      const entry = files[index];
      const report = await verifyArtifactAcrossGateways({
        cid: entry.cid,
        expectedSize: entry.size,
        expectedSha256: entry.sha256,
        gateways,
        minimumIndependentGateways,
        fetchImpl,
        delayMs,
        timeoutMs,
        sleep,
      });
      artifacts[index] = {
        name: entry.name,
        cid: entry.cid,
        verified: report.verified,
        matchedGateways: report.matchedGateways,
        results: report.results,
      };
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, Math.max(files.length, 1)) },
      () => worker(),
    ),
  );
  const verifiedArtifacts = artifacts.filter(
    (artifact) => artifact.verified,
  ).length;
  return {
    runId: validated.runId,
    county: validated.county,
    verified: files.length > 0 && verifiedArtifacts === files.length,
    checkedArtifacts: files.length,
    verifiedArtifacts,
    minimumIndependentGateways,
    gateways: gateways.map((gateway) => normalizeGateway(gateway).base),
    artifacts,
  };
}
