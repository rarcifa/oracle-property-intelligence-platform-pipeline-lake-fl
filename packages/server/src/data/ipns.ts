/**
 * Resolving the published dataset's IPNS name at runtime.
 *
 * Each run pins a new immutable root CID and re-points one IPNS name at it, so
 * the name is the only identifier that keeps meaning across runs. The deployed
 * function used to be handed a CID baked into its environment at `cdk deploy`
 * time, which meant a scheduled publish moved the pointer and the runtime went
 * on serving the previous run until somebody redeployed. The pointer is the
 * source of truth; this module follows it.
 *
 * One GET does both halves of the job. The gateway answers `/ipns/<name>/…`
 * with an `x-ipfs-roots` header whose first entry is the CID the name resolved
 * to, and the body of `index.json` names the run. Resolving through
 * a named small file rather than the directory root also keeps the response
 * small — the header identifies the run, the body dates it.
 *
 * Only some gateways resolve IPNS at all: `gateway.pinata.cloud` and
 * `gw.ipfs-lens.dev` answer 403 to every `/ipns/` path, which is why
 * `IPNS_GATEWAYS` is a narrower list than the range-read one.
 *
 * Every one of them is asked, in parallel, and the newest answer wins. Asking
 * one gateway is not enough, and that is measured rather than defensive:
 * minutes after run `20260910T153418Z` re-pointed the name, `ipfs.io` served
 * the new root while `ipfs.filebase.io` served `/ipns/<name>/index.json` from
 * the run before it — and `/ipns/<name>/coverage.json`, the same name on the
 * same gateway, from the run before *that*. A gateway's IPNS answer is a cache
 * entry, it goes stale per path, and how stale is not bounded by anything the
 * client can see. Run ids are compact UTC timestamps, so the `runId` inside
 * each candidate's own `index.json` orders the answers and the highest is the
 * newest published run any reachable gateway knows about.
 *
 * If none answers, this throws rather than quietly serving a remembered CID: a
 * wrong dataset that looks right is worse than a runtime that says it cannot
 * open one.
 */

import { IPNS_GATEWAYS, type IpfsGateway, ipnsUrl } from "@oracle-lake/shared";

/** The published run an IPNS name currently points at. */
export interface PublishedRunPointer {
  /** The IPNS name that was resolved. */
  ipnsName: string;
  /** The immutable root CID it resolved to. */
  rootCid: string;
  /** The run id inside that snapshot; every probed file carries one. */
  runId: string | null;
  /**
   * Properties the snapshot's own index claims, for a boot-time sanity check.
   * Only `index.json` carries it, so a pointer resolved from another probe file
   * reports null rather than a guess.
   */
  propertyCount: number | null;
  /** The gateway that answered. */
  gateway: string;
  /**
   * How this pointer was arrived at.
   *
   * `ipns` means a gateway resolved the name during this call. `last-known-good`
   * means it is the pointer a previous resolution produced, replayed from disk
   * so a cold start does not have to wait for the network — see
   * `readLastKnownGood` in `./source.ts`.
   */
  origin: "ipns" | "last-known-good";
}

/**
 * Paths resolved to read the pointer. Both are small, present in every run, and
 * carry the run id.
 *
 * Two rather than one because a gateway's IPNS answer is cached per path and
 * the entries go stale independently: `ipfs.filebase.io` was measured serving
 * `/ipns/<name>/index.json` from run `20260910T135850Z` and
 * `/ipns/<name>/coverage.json` from run `20260910T153418Z` in the same second.
 * Asking for both costs one extra small request per gateway and means a single
 * reachable gateway can still yield its freshest answer — which matters where
 * the public gateways rate-limit datacenter egress and only one may respond.
 */
export const IPNS_PROBE_PATHS: readonly string[] = Object.freeze(["index.json", "coverage.json"]);

/** How long one gateway gets before the next is tried. */
export const IPNS_RESOLVE_TIMEOUT_MS = 8_000;

const CID_PATTERN = /^ba[a-z2-7]{20,}$/;

/**
 * The CID an `x-ipfs-roots` header resolved the *name* to.
 *
 * The header lists every CID along the resolved path, root first, so the first
 * entry is the directory the name points at and the rest are the objects inside
 * it that were walked to reach the probe file.
 */
export function rootCidFromRootsHeader(header: string | null): string | null {
  const first = header?.split(",")[0]?.trim() ?? "";
  return CID_PATTERN.test(first) ? first : null;
}

export interface ResolveIpnsOptions {
  gateways?: readonly IpfsGateway[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Ask one gateway what the name resolves to.
 *
 * @returns the pointer that gateway reports, or a description of why it could
 *   not report one. A gateway that fails is evidence, not an error.
 */
async function askGateway(
  ipnsName: string,
  gateway: IpfsGateway,
  probePath: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ pointer: PublishedRunPointer } | { failure: string }> {
  const url = ipnsUrl(gateway, ipnsName, probePath);
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetchImpl(url, { redirect: "follow", signal: controller.signal });
    if (!response.ok) return { failure: `${gateway.id}/${probePath}: HTTP ${response.status}` };
    const rootCid = rootCidFromRootsHeader(response.headers.get("x-ipfs-roots"));
    if (rootCid === null) {
      return {
        failure: `${gateway.id}/${probePath}: no x-ipfs-roots header to resolve the name from`,
      };
    }
    // The body dates the answer; a gateway that serves the header and a body
    // this cannot parse has still resolved the pointer, it just cannot be
    // ordered against the others.
    let runId: string | null = null;
    let propertyCount: number | null = null;
    try {
      const index = (await response.json()) as { runId?: unknown; propertyCount?: unknown };
      runId = typeof index.runId === "string" ? index.runId : null;
      propertyCount = typeof index.propertyCount === "number" ? index.propertyCount : null;
    } catch {
      runId = null;
    }
    return {
      pointer: {
        ipnsName,
        rootCid,
        runId,
        propertyCount,
        gateway: gateway.baseUrl,
        origin: "ipns",
      },
    };
  } catch (error) {
    return {
      failure: `${gateway.id}/${probePath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve an IPNS name to the newest run any reachable gateway reports.
 *
 * @throws when no gateway resolves the name. There is deliberately no fallback
 *   to a previously known CID: the caller asked for whatever the name points at
 *   now, and answering with something else would be a lie about which dataset
 *   the runtime is serving.
 */
export async function resolveIpnsRun(
  ipnsName: string,
  options: ResolveIpnsOptions = {},
): Promise<PublishedRunPointer> {
  if (ipnsName.trim().length === 0) throw new Error("An IPNS name is required to resolve a run");
  const gateways = options.gateways ?? IPNS_GATEWAYS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? IPNS_RESOLVE_TIMEOUT_MS;

  const probes = gateways.flatMap((gateway) =>
    IPNS_PROBE_PATHS.map((probePath) => ({ gateway, probePath })),
  );
  const answers = await Promise.all(
    probes.map(({ gateway, probePath }) =>
      askGateway(ipnsName, gateway, probePath, fetchImpl, timeoutMs),
    ),
  );
  const pointers = answers.flatMap((answer) => ("pointer" in answer ? [answer.pointer] : []));
  if (pointers.length === 0) {
    const failures = answers.flatMap((answer) => ("failure" in answer ? [answer.failure] : []));
    throw new Error(
      `No gateway resolved IPNS name ${ipnsName}. Tried ${probes.length} probes across ` +
        `${gateways.length} gateways: ${failures.join("; ")}`,
    );
  }

  // Highest run id wins; run ids are compact UTC timestamps, so that is the
  // newest run. `reduce` keeps the earliest gateway in preference order when
  // two report the same run, and an answer whose index could not be parsed
  // only wins if nothing better answered.
  return pointers.reduce((newest, candidate) =>
    (candidate.runId ?? "") > (newest.runId ?? "") ? candidate : newest,
  );
}

/**
 * Resolve once per process and reuse the answer.
 *
 * A Lambda container serves many invocations and the published pointer moves at
 * most daily, so re-resolving per request would spend a round trip on every
 * call to learn the same CID. Caching for the container's lifetime keeps the
 * cost to one resolution per cold start, and a new container — which is what a
 * republish will eventually be served by — resolves afresh. A failure is not
 * cached, for the same reason `OracleDataStore.init` does not cache one.
 */
export function createIpnsResolver(
  options: ResolveIpnsOptions = {},
): (ipnsName: string) => Promise<PublishedRunPointer> {
  const inFlight = new Map<string, Promise<PublishedRunPointer>>();
  return (ipnsName: string): Promise<PublishedRunPointer> => {
    const cached = inFlight.get(ipnsName);
    if (cached !== undefined) return cached;
    const pending = resolveIpnsRun(ipnsName, options).catch((error: unknown) => {
      inFlight.delete(ipnsName);
      throw error;
    });
    inFlight.set(ipnsName, pending);
    return pending;
  };
}

/** The process-wide resolver the server boots through. */
export const resolvePublishedRun = createIpnsResolver();
