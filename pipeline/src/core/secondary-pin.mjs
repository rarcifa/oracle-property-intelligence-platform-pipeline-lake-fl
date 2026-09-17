/**
 * Idempotent replication through an independent IPFS provider.
 *
 * The primary Filebase CAR upload is not enough for the repository's survival
 * claim. This adapter reconciles an existing deterministic pin before it asks
 * for a new one. Pinata PSA can acknowledge `pinned`; Lighthouse registration
 * only satisfies the retention gate after the accepted request, authenticated
 * inventory, public gateway bytes, and local CAR proof all agree. Receipts
 * never contain credentials.
 */

import { createHash, randomUUID } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { rename, unlink, writeFile } from "node:fs/promises";
import https from "node:https";
import { CID } from "multiformats/cid";
import { validateCarArchive } from "./car.mjs";

const LIGHTHOUSE_BASE = "https://api.lighthouse.storage";
const LIGHTHOUSE_PAGE_SIZE = 2000;
const TERMINAL_FAILURES = new Set(["failed"]);
const IN_PROGRESS = new Set(["queued", "pinning"]);
const LIGHTHOUSE_GATEWAY_BASE = "https://gateway.lighthouse.storage/ipfs";

function serviceBase(endpoint) {
  const url = new URL(endpoint);
  if (url.protocol !== "https:") {
    throw new Error("secondary pin service endpoint must use HTTPS");
  }
  if (url.hostname === "s3.filebase.com" || url.hostname.endsWith(".filebase.io")) {
    throw new Error("secondary pin service must be independent from the primary Filebase vendor");
  }
  return url.toString().replace(/\/$/, "");
}

/** Validate provider independence before the primary upload can start. */
export function validateSecondaryPinServiceEndpoint(endpoint) {
  return serviceBase(endpoint);
}

function headers(token, json = false) {
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new Error("secondary pin service token is required");
  }
  return {
    authorization: `Bearer ${token}`,
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

async function responseJson(response, operation) {
  if (!response.ok) {
    throw new Error(`secondary pin service ${operation} failed: HTTP ${response.status}`);
  }
  return response.json();
}

function validateStatus(value, expectedCid, expectedName) {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.requestid !== "string" ||
    typeof value.status !== "string" ||
    value.pin?.cid !== expectedCid ||
    value.pin?.name !== expectedName
  ) {
    throw new Error("secondary pin service returned an invalid or mismatched pin status");
  }
  return value;
}

/** Find a prior deterministic request so a retry never creates a second pin. */
export async function findSecondaryPin({ endpoint, token, cid, name, fetchImpl = fetch }) {
  const query = new URL(`${serviceBase(endpoint)}/pins`);
  query.searchParams.set("cid", cid);
  query.searchParams.set("name", name);
  query.searchParams.set("status", "queued,pinning,pinned,failed");
  const payload = await responseJson(await fetchImpl(query, { headers: headers(token) }), "list");
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const exact = results.find((entry) => entry?.pin?.cid === cid && entry?.pin?.name === name);
  return exact ? validateStatus(exact, cid, name) : null;
}

/** Poll one request to a terminal, independently pinned state. */
export async function waitForSecondaryPin({
  endpoint,
  token,
  cid,
  name,
  requestId,
  fetchImpl = fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  attempts = 30,
  intervalMs = 10_000,
}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const status = validateStatus(
      await responseJson(
        await fetchImpl(`${serviceBase(endpoint)}/pins/${encodeURIComponent(requestId)}`, {
          headers: headers(token),
        }),
        "status",
      ),
      cid,
      name,
    );
    if (status.status === "pinned") return status;
    if (TERMINAL_FAILURES.has(status.status)) {
      throw new Error(`secondary pin service failed request ${requestId}`);
    }
    if (!IN_PROGRESS.has(status.status)) {
      throw new Error(`secondary pin service returned unsupported status ${status.status}`);
    }
    if (attempt < attempts) await sleep(intervalMs);
  }
  throw new Error(`secondary pin service did not pin ${cid} within ${attempts} checks`);
}

/** Reconcile or create one pin and return a token-free durable receipt. */
export async function ensureSecondaryPin({
  endpoint,
  token,
  cid,
  name,
  fetchImpl = fetch,
  beforeCreate = () => {},
  sleep,
  attempts,
  intervalMs,
}) {
  let status = await findSecondaryPin({ endpoint, token, cid, name, fetchImpl });
  if (status === null) {
    await beforeCreate();
    status = validateStatus(
      await responseJson(
        await fetchImpl(`${serviceBase(endpoint)}/pins`, {
          method: "POST",
          headers: headers(token, true),
          body: JSON.stringify({ cid, name }),
        }),
        "create",
      ),
      cid,
      name,
    );
  }
  if (status.status !== "pinned") {
    status = await waitForSecondaryPin({
      endpoint,
      token,
      cid,
      name,
      requestId: status.requestid,
      fetchImpl,
      sleep,
      attempts,
      intervalMs,
    });
  }
  return {
    serviceHost: new URL(serviceBase(endpoint)).host,
    requestId: status.requestid,
    cid,
    name,
    status: "pinned",
  };
}

/** Lighthouse is not PSA: never append /pins or send a Pinata JWT to it. */
function lighthouseBase(endpoint) {
  if (endpoint !== LIGHTHOUSE_BASE) {
    throw new Error("Lighthouse endpoint must exactly equal https://api.lighthouse.storage");
  }
  return endpoint;
}

function canonicalCid(value) {
  try {
    return CID.parse(value).toV1().toString();
  } catch {
    throw new Error("Lighthouse returned an invalid CID");
  }
}

function lighthouseSize(value) {
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) value = Number(value);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Lighthouse returned an invalid file size");
  }
  return value;
}

function sha256Digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function extractLighthouseRequestId(value) {
  const visit = (node, depth = 0) => {
    if (depth > 2 || node === null || typeof node !== "object") return null;
    for (const key of ["requestID", "requestId", "request_id"]) {
      if (typeof node[key] === "string" && node[key].trim()) return node[key].trim();
    }
    for (const child of Object.values(node)) {
      const found = visit(child, depth + 1);
      if (found) return found;
    }
    return null;
  };
  if (typeof value !== "string") return visit(value);
  try {
    return visit(JSON.parse(value));
  } catch {
    return null;
  }
}

export function lighthouseDnsServersFromEnv(environment = process.env) {
  const raw = environment.LIGHTHOUSE_DNS_SERVERS;
  if (typeof raw !== "string" || raw.trim().length === 0) return [];
  return raw
    .split(/[,\s]+/u)
    .map((server) => server.trim())
    .filter(Boolean);
}

export function createLighthouseGatewayFetch({ dnsServers = lighthouseDnsServersFromEnv() } = {}) {
  const servers = [...dnsServers];
  return async function lighthouseGatewayFetch(url, options = {}) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== "gateway.lighthouse.storage") {
      throw new Error("Lighthouse public proof must use https://gateway.lighthouse.storage");
    }
    const resolver = servers.length > 0 ? new Resolver() : null;
    if (resolver) resolver.setServers(servers);
    const lookup = resolver
      ? async (hostname, lookupOptions, callback) => {
          if (typeof lookupOptions === "function") {
            callback = lookupOptions;
            lookupOptions = {};
          }
          try {
            const ipv4 = await resolver.resolve4(hostname).catch(() => []);
            const ipv6 = await resolver.resolve6(hostname).catch(() => []);
            const addresses = [
              ...ipv4.map((address) => ({ address, family: 4 })),
              ...ipv6.map((address) => ({ address, family: 6 })),
            ];
            if (addresses.length === 0) {
              throw new Error(`Lighthouse DNS override resolved no addresses for ${hostname}`);
            }
            if (lookupOptions?.all === true) {
              callback(null, addresses);
            } else {
              callback(null, addresses[0].address, addresses[0].family);
            }
          } catch (error) {
            callback(error);
          }
        }
      : undefined;
    return new Promise((resolve, reject) => {
      const request = https.request(
        parsed,
        {
          method: options.method ?? "GET",
          headers: options.headers,
          signal: options.signal,
          lookup,
        },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          response.on("end", () =>
            resolve(
              new globalThis.Response(Buffer.concat(chunks), {
                status: response.statusCode,
                headers: response.headers,
              }),
            ),
          );
        },
      );
      request.on("error", reject);
      request.end();
    });
  };
}

/**
 * Reconcile through the documented authenticated, paginated inventory.
 * Inventory registration is not a provider-local retention acknowledgement.
 * https://docs.lighthouse.storage/how-to/list-files
 */
export async function findLighthouseRegistration({
  endpoint,
  token,
  cid,
  name,
  fetchImpl = fetch,
  maxPages = 1000,
}) {
  lighthouseBase(endpoint);
  const expectedCid = canonicalCid(cid);
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new Error("Invalid page limit");
  let lastKey = "null";
  const seen = new Set();
  for (let page = 0; page < maxPages; page += 1) {
    const query = new URL(`${endpoint}/api/user/files_uploaded`);
    query.searchParams.set("lastKey", lastKey);
    const payload = await responseJson(
      await fetchImpl(query, {
        headers: headers(token),
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      }),
      "Lighthouse inventory",
    );
    if (
      !Array.isArray(payload?.fileList) ||
      !Number.isSafeInteger(payload.totalFiles) ||
      payload.totalFiles < 0
    ) {
      throw new Error("Lighthouse returned an invalid inventory; creation is not safe");
    }
    const exact = payload.fileList.filter(
      (entry) =>
        typeof entry?.cid === "string" &&
        canonicalCid(entry.cid) === expectedCid &&
        entry.fileName === name,
    );
    if (exact.length > 1) throw new Error("Lighthouse returned ambiguous matching registrations");
    if (exact.length === 1) {
      const entry = exact[0];
      if (typeof entry.id !== "string" || !entry.id || entry.encryption !== false) {
        throw new Error("Lighthouse registration lacks an identifier or is not explicitly public");
      }
      return {
        id: entry.id,
        cid: entry.cid,
        fileName: entry.fileName,
        fileSizeInBytes: lighthouseSize(entry.fileSizeInBytes),
        encryption: entry.encryption,
        ...(typeof entry.status === "string" ? { providerStatus: entry.status } : {}),
      };
    }
    if (payload.fileList.length < LIGHTHOUSE_PAGE_SIZE) return null;
    const next = payload.lastKey ?? payload.fileList.at(-1)?.id;
    if (typeof next !== "string" || !next || seen.has(next) || next === lastKey) {
      throw new Error("Lighthouse inventory pagination did not advance");
    }
    seen.add(next);
    lastKey = next;
  }
  throw new Error("Lighthouse inventory exceeded the page limit; creation is not safe");
}

/**
 * Use the documented same-CID pin endpoint, then reconcile inventory/metadata.
 * HTTP success is accepted, NOT pinned. Registration is reconciled, NOT retained.
 * expectedDagBytes explicitly checks the observed unique-block size representation;
 * legacy expectedBytes retains its strict equality contract. Neither is fetched
 * logical-file byte proof, and the two expectations cannot be mixed.
 * Preserve the response digest and actual provider identifiers without secrets.
 * https://docs.lighthouse.storage/how-to/pin-cid
 * https://docs.lighthouse.storage/how-to/file-info
 */
export async function ensureLighthouseRegistration({
  endpoint,
  token,
  cid,
  name,
  expectedBytes = null,
  expectedDagBytes = null,
  fetchImpl = fetch,
  beforeCreate = () => {},
  previousEvidence = null,
  onEvidence = async () => {},
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  attempts = 30,
  intervalMs = 10_000,
  allowPendingEvidence = false,
}) {
  lighthouseBase(endpoint);
  if (
    !Number.isSafeInteger(attempts) ||
    attempts < 1 ||
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 0 ||
    typeof allowPendingEvidence !== "boolean"
  ) {
    throw new Error("Invalid Lighthouse polling bounds");
  }
  if (expectedBytes !== null) lighthouseSize(expectedBytes);
  if (
    expectedDagBytes !== null &&
    (!Number.isSafeInteger(expectedDagBytes) || expectedDagBytes < 0)
  )
    throw new Error("Expected Lighthouse DAG bytes must be a non-negative safe integer");
  if (expectedBytes !== null && expectedDagBytes !== null)
    throw new Error("Choose exactly one Lighthouse size expectation: file bytes or DAG bytes");
  if (
    previousEvidence !== null &&
    (previousEvidence.provider !== "lighthouse" ||
      previousEvidence.cid !== cid ||
      previousEvidence.name !== name ||
      previousEvidence.serviceHost !== new URL(endpoint).host ||
      (previousEvidence.requestAccepted !== null &&
        previousEvidence.requestAccepted !== undefined &&
        (previousEvidence.requestAccepted.state !== "request-accepted" ||
          !Number.isInteger(previousEvidence.requestAccepted.httpStatus) ||
          previousEvidence.requestAccepted.httpStatus < 200 ||
          previousEvidence.requestAccepted.httpStatus > 299 ||
          !/^sha256:[a-f0-9]{64}$/.test(previousEvidence.requestAccepted.responseDigest))) ||
      (!previousEvidence.requestAccepted &&
        previousEvidence.requestIntent?.state !== "request-submitting"))
  )
    throw new Error("Lighthouse accepted-request checkpoint does not match this target");
  const normalizedPreviousAccepted =
    previousEvidence?.requestAccepted &&
    !previousEvidence.requestAccepted.requestId &&
    previousEvidence.requestAccepted.responseBody
      ? {
          ...previousEvidence.requestAccepted,
          ...(extractLighthouseRequestId(previousEvidence.requestAccepted.responseBody)
            ? {
                requestId: extractLighthouseRequestId(
                  previousEvidence.requestAccepted.responseBody,
                ),
              }
            : {}),
        }
      : previousEvidence?.requestAccepted;
  let registration = await findLighthouseRegistration({ endpoint, token, cid, name, fetchImpl });
  let requestAccepted = normalizedPreviousAccepted ?? null;
  let requestIntent = previousEvidence?.requestIntent ?? null;
  if (registration === null && requestAccepted === null && requestIntent === null) {
    // Persist intent before POST: an interrupted request is not safe to repeat
    // merely because the provider's asynchronous inventory is still empty.
    requestIntent = { state: "request-submitting" };
    await onEvidence({
      serviceHost: new URL(endpoint).host,
      provider: "lighthouse",
      cid,
      name,
      status: "request-submitting",
      retentionVerified: false,
      requestIntent,
      requestAccepted: null,
    });
    await beforeCreate();
    const response = await fetchImpl(`${endpoint}/api/lighthouse/pin`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers: headers(token, true),
      body: JSON.stringify({ cid, fileName: name }),
    });
    if (!response.ok) {
      throw new Error(`secondary pin service Lighthouse create failed: HTTP ${response.status}`);
    }
    const body = await response.text();
    requestAccepted = {
      state: "request-accepted",
      httpStatus: response.status,
      responseDigest: `sha256:${createHash("sha256").update(body).digest("hex")}`,
      ...(extractLighthouseRequestId(body)
        ? { requestId: extractLighthouseRequestId(body) }
        : {}),
      // Private checkpoint only. Keep actual acknowledgement text for review,
      // but never retain an echoed credential in a receipt or public ledger.
      responseBody: body.replaceAll(token, "[REDACTED]"),
      bodyRedacted: body.includes(token),
    };
    await onEvidence({
      serviceHost: new URL(endpoint).host,
      provider: "lighthouse",
      cid,
      name,
      status: "request-accepted",
      retentionVerified: false,
      requestIntent,
      requestAccepted,
    });
  }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    registration ??= await findLighthouseRegistration({ endpoint, token, cid, name, fetchImpl });
    if (registration) {
      const query = new URL(`${endpoint}/api/lighthouse/file_info`);
      query.searchParams.set("cid", cid);
      const info = await responseJson(
        await fetchImpl(query, { redirect: "error", signal: AbortSignal.timeout(20_000) }),
        "Lighthouse metadata",
      );
      const size = lighthouseSize(info?.fileSizeInBytes);
      if (
        canonicalCid(info?.cid) !== canonicalCid(cid) ||
        info?.encryption !== false ||
        size !== registration.fileSizeInBytes ||
        (expectedBytes !== null && size !== expectedBytes) ||
        (expectedDagBytes !== null && size !== expectedDagBytes)
      ) {
        throw new Error("Lighthouse metadata does not match the public CID/size registration");
      }
      const receipt = {
        serviceHost: new URL(endpoint).host,
        provider: "lighthouse",
        cid,
        name,
        status: "registration-reconciled",
        retentionVerified: false,
        requestAccepted,
        requestIntent,
        registration,
        metadata: { cid: info.cid, fileSizeInBytes: size, encryption: info.encryption },
      };
      await onEvidence(receipt);
      return receipt;
    }
    if (attempt < attempts - 1) await sleep(intervalMs);
  }
  if (allowPendingEvidence) {
    const receipt = {
      serviceHost: new URL(endpoint).host,
      provider: "lighthouse",
      cid,
      name,
      status: requestAccepted ? "request-accepted" : "request-outcome-uncertain",
      retentionVerified: false,
      requestIntent,
      requestAccepted,
    };
    await onEvidence(receipt);
    return receipt;
  }
  throw new Error(
    "Lighthouse request registration was not reconciled; do not create again blindly",
  );
}

/** Acknowledgement bodies stay private; the ledger binds their digest only. */
export function publicLighthouseReceipt(receipt) {
  return {
    serviceHost: receipt.serviceHost,
    provider: receipt.provider,
    cid: receipt.cid,
    name: receipt.name,
    status: receipt.status,
    retentionVerified: receipt.status === "retention-evidence-verified",
    requestIntent: receipt.requestIntent,
    requestAccepted: receipt.requestAccepted
      ? {
          state: receipt.requestAccepted.state,
          httpStatus: receipt.requestAccepted.httpStatus,
          responseDigest: receipt.requestAccepted.responseDigest,
          ...(receipt.requestAccepted.requestId
            ? { requestId: receipt.requestAccepted.requestId }
            : {}),
        }
      : null,
    ...(receipt.registration
      ? {
          registration: {
            id: receipt.registration.id,
            cid: receipt.registration.cid,
            fileName: receipt.registration.fileName,
            fileSizeInBytes: receipt.registration.fileSizeInBytes,
            encryption: receipt.registration.encryption,
          },
          metadata: receipt.metadata,
        }
      : {}),
    ...(receipt.publicGateway ? { publicGateway: receipt.publicGateway } : {}),
    ...(receipt.retentionEvidence ? { retentionEvidence: receipt.retentionEvidence } : {}),
  };
}

function assertLighthouseVerifiedReceipt(receipt) {
  if (
    receipt?.provider !== "lighthouse" ||
    receipt?.serviceHost !== "api.lighthouse.storage" ||
    receipt?.status !== "retention-evidence-verified" ||
    receipt?.retentionVerified !== true ||
    receipt?.requestAccepted?.state !== "request-accepted" ||
    !Number.isInteger(receipt.requestAccepted.httpStatus) ||
    receipt.requestAccepted.httpStatus < 200 ||
    receipt.requestAccepted.httpStatus > 299 ||
    typeof receipt.requestAccepted.requestId !== "string" ||
    receipt.requestAccepted.requestId.length === 0 ||
    !/^sha256:[a-f0-9]{64}$/.test(receipt.requestAccepted.responseDigest) ||
    receipt?.registration?.encryption !== false ||
    receipt?.registration?.fileName !== receipt?.name ||
    canonicalCid(receipt?.registration?.cid) !== canonicalCid(receipt?.cid) ||
    receipt?.metadata?.encryption !== false ||
    canonicalCid(receipt?.metadata?.cid) !== canonicalCid(receipt?.cid) ||
    receipt?.metadata?.fileSizeInBytes !== receipt?.registration?.fileSizeInBytes
  ) {
    throw new Error(
      "Lighthouse retention evidence is incomplete; publication promotion remains held",
    );
  }
}

function assertLighthouseGatewayBytesEvidence(receipt) {
  assertLighthouseVerifiedReceipt(receipt);
  if (
    receipt?.publicGateway?.host !== "gateway.lighthouse.storage" ||
    canonicalCid(receipt.publicGateway.cid) !== canonicalCid(receipt.cid) ||
    !Number.isSafeInteger(receipt.publicGateway.bytes) ||
    receipt.publicGateway.bytes < 0 ||
    !/^sha256:[a-f0-9]{64}$/.test(receipt.publicGateway.sha256)
  ) {
    throw new Error(
      "Lighthouse gateway byte evidence is incomplete; publication promotion remains held",
    );
  }
}

function assertLighthouseArchiveReceipt(receipt) {
  assertLighthouseGatewayBytesEvidence(receipt);
  if (
    !Array.isArray(receipt.publicGateway.car?.roots) ||
    receipt.publicGateway.car.roots.length === 0 ||
    !Number.isSafeInteger(receipt.publicGateway.car.verifiedBlocks) ||
    receipt.publicGateway.car.verifiedBlocks < 1
  ) {
    throw new Error(
      "Lighthouse archive CAR evidence is incomplete; publication promotion remains held",
    );
  }
}

function assertLighthouseRootCoveredByArchive(rootReceipt, archiveReceipt) {
  assertLighthouseVerifiedReceipt(rootReceipt);
  assertLighthouseArchiveReceipt(archiveReceipt);
  const archiveRoots = archiveReceipt.publicGateway.car.roots.map((root) => canonicalCid(root));
  if (
    rootReceipt.retentionEvidence?.coveredBy !== "lighthouse-snapshot-car" ||
    canonicalCid(rootReceipt.retentionEvidence?.archiveCid) !== canonicalCid(archiveReceipt.cid) ||
    JSON.stringify(rootReceipt.retentionEvidence?.expectedRoots?.map((root) => canonicalCid(root))) !==
      JSON.stringify(archiveRoots) ||
    !archiveRoots.includes(canonicalCid(rootReceipt.cid))
  ) {
    throw new Error(
      "Lighthouse root coverage is not bound to the verified archive receipt; publication promotion remains held",
    );
  }
}

function assertLighthouseRegistrationProof(receipt) {
  if (
    receipt?.provider !== "lighthouse" ||
    receipt?.serviceHost !== "api.lighthouse.storage" ||
    receipt?.status !== "registration-reconciled" ||
    receipt?.retentionVerified !== false ||
    receipt?.requestAccepted?.state !== "request-accepted" ||
    !Number.isInteger(receipt.requestAccepted.httpStatus) ||
    receipt.requestAccepted.httpStatus < 200 ||
    receipt.requestAccepted.httpStatus > 299 ||
    typeof receipt.requestAccepted.requestId !== "string" ||
    receipt.requestAccepted.requestId.length === 0 ||
    !/^sha256:[a-f0-9]{64}$/.test(receipt.requestAccepted.responseDigest) ||
    receipt?.registration?.encryption !== false ||
    receipt?.registration?.fileName !== receipt?.name ||
    canonicalCid(receipt?.registration?.cid) !== canonicalCid(receipt?.cid) ||
    receipt?.metadata?.encryption !== false ||
    canonicalCid(receipt?.metadata?.cid) !== canonicalCid(receipt?.cid) ||
    receipt?.metadata?.fileSizeInBytes !== receipt?.registration?.fileSizeInBytes
  ) {
    throw new Error(
      "Lighthouse retention evidence is incomplete; publication promotion remains held",
    );
  }
}

function expectedGatewayUrl(cid, gatewayBase = LIGHTHOUSE_GATEWAY_BASE) {
  const base = new URL(gatewayBase);
  if (base.protocol !== "https:" || base.hostname !== "gateway.lighthouse.storage") {
    throw new Error("Lighthouse public proof must use https://gateway.lighthouse.storage");
  }
  const normalized = base.toString().replace(/\/$/, "");
  return `${normalized}/${canonicalCid(cid)}`;
}

async function fetchLighthouseGatewayBytes({
  cid,
  gatewayBase,
  gatewayFetchImpl,
  timeoutMs = 20_000,
}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
    throw new Error("Lighthouse public proof timeout must be between 1ms and 600000ms");
  }
  const url = expectedGatewayUrl(cid, gatewayBase);
  const response = await gatewayFetchImpl(url, {
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Lighthouse public gateway proof failed: HTTP ${response.status}`);
  }
  return { url, bytes: Buffer.from(await response.arrayBuffer()) };
}

function assertExactBytes(bytes, expectedBytes, expectedSha256, label) {
  if (!(expectedBytes instanceof Uint8Array)) {
    throw new Error(`${label} expected bytes are required for Lighthouse proof`);
  }
  if (bytes.byteLength !== expectedBytes.byteLength) {
    throw new Error(`${label} Lighthouse gateway bytes differ from the expected length`);
  }
  const actualDigest = sha256Digest(bytes);
  const expectedDigest = expectedSha256 ?? sha256Digest(expectedBytes);
  if (actualDigest !== expectedDigest || !Buffer.from(bytes).equals(Buffer.from(expectedBytes))) {
    throw new Error(`${label} Lighthouse gateway bytes differ from the expected digest`);
  }
  return actualDigest;
}

/**
 * Promote one reconciled Lighthouse registration only after independent public
 * evidence is complete. For raw/file payloads this compares exact public
 * gateway bytes. For CAR payloads it additionally validates the CAR header,
 * every reachable block, and the exact expected roots.
 */
export async function verifyLighthouseRetentionEvidence({
  receipt,
  expectedDagBytes,
  expectedBytes = null,
  expectedSha256 = null,
  expectedCarRoots = null,
  coveredByCar = null,
  timeoutMs = 20_000,
  gatewayBase = LIGHTHOUSE_GATEWAY_BASE,
  gatewayFetchImpl = createLighthouseGatewayFetch(),
}) {
  assertLighthouseRegistrationProof(receipt);
  lighthouseSize(expectedDagBytes);
  if (receipt.registration.fileSizeInBytes !== expectedDagBytes) {
    throw new Error("Lighthouse inventory DAG size does not match the verified local evidence");
  }
  let publicGateway = null;
  let retentionEvidence = null;
  if (expectedBytes !== null) {
    const { url, bytes } = await fetchLighthouseGatewayBytes({
      cid: receipt.cid,
      gatewayBase,
      gatewayFetchImpl,
      timeoutMs,
    });
    const digest = assertExactBytes(bytes, expectedBytes, expectedSha256, receipt.name);
    publicGateway = {
      host: new URL(url).host,
      cid: receipt.cid,
      bytes: bytes.byteLength,
      sha256: digest,
    };
    if (expectedCarRoots !== null) {
      const car = validateCarArchive(bytes);
      const expectedRoots = expectedCarRoots.map((root) => canonicalCid(root));
      if (JSON.stringify(car.roots) !== JSON.stringify(expectedRoots)) {
        throw new Error("Lighthouse public CAR roots do not match the expected snapshot roots");
      }
      publicGateway.car = {
        roots: car.roots,
        verifiedBlocks: car.blocks.length,
      };
    }
  } else if (coveredByCar !== null) {
    assertLighthouseArchiveReceipt(coveredByCar.archiveReceipt);
    const expectedRoots = coveredByCar.archiveReceipt.publicGateway.car.roots.map((root) =>
      canonicalCid(root),
    );
    if (!expectedRoots.includes(canonicalCid(receipt.cid))) {
      throw new Error("Lighthouse root CID is not covered by the verified snapshot CAR");
    }
    retentionEvidence = {
      coveredBy: "lighthouse-snapshot-car",
      archiveCid: canonicalCid(coveredByCar.archiveReceipt.cid),
      expectedRoots,
    };
  } else {
    throw new Error("Lighthouse public gateway bytes are required for retention proof");
  }
  return publicLighthouseReceipt({
    ...receipt,
    status: "retention-evidence-verified",
    retentionVerified: true,
    ...(publicGateway ? { publicGateway } : {}),
    ...(retentionEvidence ? { retentionEvidence } : {}),
  });
}

/** A registered/requested copy must never silently advance the retained-pin gate. */
export function assertSecondaryRetention(receipts, provider = "pinata") {
  if (!Array.isArray(receipts) || receipts.length !== 3) {
    throw new Error(
      "Secondary registration is not verified IPFS retention; gateway/history/IPNS promotion remains held",
    );
  }
  if (provider === "pinata") {
    if (
      receipts.some(
        (receipt) => receipt?.status !== "pinned" || receipt?.retentionVerified === false,
      )
    ) {
      throw new Error(
        "Secondary registration is not verified IPFS retention; gateway/history/IPNS promotion remains held",
      );
    }
    return;
  }
  if (provider === "lighthouse") {
    try {
      for (const receipt of receipts) assertLighthouseVerifiedReceipt(receipt);
      const [root, manifest, archive] = receipts;
      assertLighthouseRootCoveredByArchive(root, archive);
      assertLighthouseGatewayBytesEvidence(manifest);
      assertLighthouseArchiveReceipt(archive);
    } catch {
      throw new Error(
        "Secondary registration is not verified IPFS retention; gateway/history/IPNS promotion remains held",
      );
    }
    return;
  }
  throw new Error(
    "Secondary registration is not verified IPFS retention; gateway/history/IPNS promotion remains held",
  );
}

/** Replace a private checkpoint only after its complete write succeeds. */
export async function writeLighthouseCheckpoint(
  filePath,
  receipt,
  fileOperations = { writeFile, rename, unlink },
) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fileOperations.writeFile(temporaryPath, `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await fileOperations.rename(temporaryPath, filePath);
  } finally {
    await fileOperations.unlink(temporaryPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
