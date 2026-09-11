/**
 * Idempotent replication through an independent IPFS Pinning Service API.
 *
 * The primary Filebase CAR upload is not enough for the repository's survival
 * claim. This adapter reconciles an existing deterministic pin before it asks
 * for a new one, waits for `pinned`, and returns a secret-free receipt suitable
 * for the append-only publication ledger.
 */

const TERMINAL_FAILURES = new Set(["failed"]);
const IN_PROGRESS = new Set(["queued", "pinning"]);

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
  const payload = await responseJson(
    await fetchImpl(query, { headers: headers(token) }),
    "list",
  );
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
    beforeCreate();
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
