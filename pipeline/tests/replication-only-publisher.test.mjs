/** Offline control-flow fixtures: no real data proof, provider or filesystem writes. */
import { generateKeyPairSync } from "node:crypto";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CID } from "multiformats/cid";

const fixture = vi.hoisted(() => ({
  files: new Map(),
  objects: new Map(),
  registrations: [],
  writes: [],
  puts: vi.fn(),
  gateway: vi.fn(),
  env: vi.fn(),
  provenance: vi.fn(),
  registered: true,
  getHook: null,
  predecessor: null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal();
  const missing = () => Object.assign(new Error("missing offline fixture"), { code: "ENOENT" });
  return {
    ...actual,
    mkdir: async () => {},
    readFile: async (name, options) => {
      const bytes = fixture.files.get(String(name));
      if (!bytes) throw missing();
      const encoding = typeof options === "string" ? options : options?.encoding;
      return encoding ? bytes.toString(encoding) : Buffer.from(bytes);
    },
    writeFile: async (name, bytes, options) => {
      if (options?.flag === "wx" && fixture.files.has(String(name)))
        throw Object.assign(new Error("exists"), { code: "EEXIST" });
      fixture.files.set(String(name), Buffer.from(bytes));
      fixture.writes.push(String(name));
    },
    rename: async (from, to) => {
      if (!fixture.files.has(String(from))) throw missing();
      fixture.files.set(String(to), fixture.files.get(String(from)));
      fixture.files.delete(String(from));
      fixture.writes.push(String(to));
    },
    unlink: async (name) => {
      fixture.files.delete(String(name));
    },
    readdir: async (directory) => {
      const prefix = `${directory}/`;
      const children = new Map();
      for (const name of fixture.files.keys()) {
        if (!name.startsWith(prefix)) continue;
        const relative = name.slice(prefix.length);
        const child = relative.split("/")[0];
        children.set(child, relative.includes("/"));
      }
      return [...children].map(([name, isDirectory]) => ({ name, isDirectory: () => isDirectory }));
    },
  };
});

vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    S3Client: class {
      constructor(config) {
        expect(config.maxAttempts).toBe(1);
        this.config = { maxAttempts: async () => config.maxAttempts };
      }
      async send(command) {
        const { Bucket, Key, Body } = command.input;
        const identity = `${Bucket}/${Key}`;
        if (command.constructor.name === "PutObjectCommand") {
          fixture.puts(command.input);
          if (fixture.objects.has(identity))
            throw Object.assign(new Error("exists"), { name: "PreconditionFailed" });
          fixture.objects.set(identity, Buffer.from(Body));
          return {};
        }
        if (fixture.getHook) await fixture.getHook(command.input);
        const bytes = fixture.objects.get(identity);
        if (!bytes)
          throw Object.assign(new Error("missing offline S3 object"), {
            name: "NoSuchKey",
            $metadata: { httpStatusCode: 404 },
          });
        return { Body: bytes, ContentLength: bytes.length };
      }
    },
  };
});

vi.mock("../scripts/lake/publication-provenance.mjs", () => ({
  currentRepositoryCommit: async () => "a".repeat(40),
  verifyPublicationProvenance: (...args) => fixture.provenance(...args),
}));
vi.mock("../src/counties/lake/adapter.mjs", () => ({
  assertQueryTableGate: async () => ({ rows: 1 }),
  assertPermitTableGate: async () => ({ rows: 1 }),
  assertBusinessTableGate: async () => ({ rows: 1 }),
}));
vi.mock("../src/core/gateway-verify.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  verifyArtifactAcrossGateways: (...args) => fixture.gateway(...args),
  verifyManifestAcrossGateways: (...args) => fixture.gateway(...args),
}));
vi.mock("../src/core/filebase.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  loadEnvFile: (...args) => fixture.env(...args),
}));
vi.mock("../src/core/secondary-pin.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    ensureLighthouseRegistration: (options) =>
      actual.ensureLighthouseRegistration({ ...options, attempts: 1, intervalMs: 0 }),
  };
});

import { publishRun } from "../scripts/lake/publish-run.mjs";
import { computeRawCid } from "../src/core/cid.mjs";
import {
  buildPublishAuthorizationPayload,
  readPublicationLedger,
  signPublishAuthorization,
} from "../src/core/publish-gate.mjs";
import { LAKE_IPNS_NETWORK_KEY } from "../src/counties/lake/enrichment-profile.mjs";

const REPO = path.resolve(process.cwd(), "..");
const RUN = "20260916T181000Z";
const PUBLISH = path.join(REPO, "pipeline/data/artifacts/publish/lake");
const LEDGER = path.join(REPO, "artifacts/publication-attempts.json");
const PREDECESSOR = computeRawCid("offline predecessor");
const OPTIONS = {
  runId: RUN,
  mode: "full",
  candidateCommit: "a".repeat(40),
  candidateWorkflowRunId: "local",
  provenanceDigest: `sha256:${"b".repeat(64)}`,
  expectedIpnsPredecessorCid: PREDECESSOR,
  expectedIpnsPredecessorSequence: 1,
  secondaryPinProvider: "lighthouse",
  executionScope: "replication-only",
  dryRun: true,
};
const APPROVAL = "/offline-owner/approval.json";
const PUBLIC_KEY = "/offline-owner/public.pem";
const setJson = (name, value) => fixture.files.set(name, Buffer.from(JSON.stringify(value)));
const reply = (value, status = 200) => new globalThis.Response(JSON.stringify(value), { status });
const protectedPaths = [
  "artifacts/run-history.json",
  "artifacts/latest.json",
  "artifacts/row-hashes.json",
  "packages/rag/corpus-source.json",
].map((name) => path.join(REPO, name));

beforeEach(() => {
  fixture.getHook = null;
  fixture.predecessor = null;
  fixture.files.clear();
  fixture.objects.clear();
  fixture.registrations.length = 0;
  fixture.writes.length = 0;
  fixture.registered = true;
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-16T21:00:00.000Z"));
  fixture.provenance.mockResolvedValue({
    candidateCommit: OPTIONS.candidateCommit,
    digest: OPTIONS.provenanceDigest,
  });
  fixture.gateway.mockImplementation(() => {
    throw new Error("gateway forbidden in limited scope");
  });
  fixture.env.mockImplementation(() => {
    throw new Error("env-file forbidden in this fixture");
  });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  for (const [key, value] of Object.entries({
    S3_ACCESS_KEY_ID: "fixture-key",
    S3_SECRET_ACCESS_KEY: "fixture-secret",
    FILEBASE_API_TOKEN: "fixture-filebase",
    IPFS_API_KEY: "fixture-lighthouse",
    SECONDARY_PIN_SERVICE_TOKEN: "fixture-pinata",
    SECONDARY_PIN_SERVICE_URL: "https://api.pinata.cloud/psa",
    LIGHTHOUSE_PIN_SERVICE_URL: "https://api.lighthouse.storage",
  }))
    vi.stubEnv(key, value);
  setJson(path.join(PUBLISH, "runs", RUN, "coverage.json"), {
    tables: {
      properties: { rows: 1 },
      permits: { rows: 1 },
      coordinates: { rows: 1 },
    },
    sourceLimitations: ["offline fixture, not county evidence"],
  });
  fixture.files.set(
    path.join(PUBLISH, "runs", RUN, "query-table.parquet"),
    Buffer.from("offline property fixture"),
  );
  fixture.files.set(
    path.join(PUBLISH, "runs", RUN, "permit-table.parquet"),
    Buffer.from("offline permit fixture"),
  );
  for (const name of protectedPaths) setJson(name, { unchanged: true });
  setJson(protectedPaths[0], {
    runs: [{ runId: "20260910T120000Z", rootCid: PREDECESSOR, tables: [] }],
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, options) => {
      const url = new URL(input);
      if (url.host === "api.filebase.io") {
        if (options?.method && options.method !== "GET") throw new Error("IPNS mutation forbidden");
        return reply([
          {
            label: "oracle-open-data-lake",
            network_key: LAKE_IPNS_NETWORK_KEY,
            cid: fixture.predecessor ?? PREDECESSOR,
            sequence: 1,
          },
        ]);
      }
      if (url.host !== "api.lighthouse.storage")
        throw new Error("unexpected offline network destination");
      if (url.pathname === "/api/user/files_uploaded")
        return reply({
          fileList: fixture.registered ? fixture.registrations : [],
          totalFiles: fixture.registered ? fixture.registrations.length : 0,
        });
      if (url.pathname === "/api/lighthouse/pin" && options?.method === "POST") {
        const request = JSON.parse(options.body);
        const size = request.fileName.endsWith("/manifest")
          ? fixture.files.get(path.join(PUBLISH, "manifests", `${RUN}.json`)).length
          : request.fileName.endsWith("/archive")
            ? fixture.files.get(path.join(PUBLISH, "cars", `${RUN}-snapshot.car`)).length
            : 0;
        fixture.registrations.push({
          id: `fixture-${fixture.registrations.length}`,
          cid:
            fixture.registered === "cidv0" && request.fileName.endsWith("/root")
              ? CID.parse(request.cid).toV0().toString()
              : request.cid,
          fileName: request.fileName,
          fileSizeInBytes: size,
          encryption: false,
        });
        return reply({ message: "fixture accepted, not a retention proof" }, 202);
      }
      if (url.pathname === "/api/lighthouse/file_info") {
        const entry = fixture.registrations.find((row) =>
          CID.parse(row.cid)
            .toV1()
            .equals(CID.parse(url.searchParams.get("cid")).toV1()),
        );
        return reply({ cid: entry.cid, fileSizeInBytes: entry.fileSizeInBytes, encryption: false });
      }
      throw new Error("unexpected offline operation");
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function signedFixture(scope = "replication-only") {
  const prepared = await publishRun(OPTIONS);
  const request = JSON.parse(fixture.files.get(prepared.approvalRequestPath).toString());
  const target = globalThis.structuredClone(request.target);
  if (scope !== "replication-only") {
    delete target.executionScope;
    target.actions.push("verify-all-artifacts-two-gateways", "append-history", "repoint-ipns");
  }
  // Ephemeral test keys only; never the owner's signing key.
  const pair = generateKeyPairSync("ed25519");
  const authorization = signPublishAuthorization(
    buildPublishAuthorizationPayload(target, {
      issuedAt: "2026-09-16T20:00:00.000Z",
      expiresAt: "2026-09-16T22:00:00.000Z",
      nonce: "offline_fixture_nonce_12345",
      approver: "offline-test",
    }),
    pair.privateKey.export({ type: "pkcs8", format: "pem" }),
  );
  setJson(APPROVAL, authorization);
  fixture.files.set(
    PUBLIC_KEY,
    Buffer.from(pair.publicKey.export({ type: "spki", format: "pem" })),
  );
  return {
    prepared,
    live: { ...OPTIONS, dryRun: false, approvalPath: APPROVAL, approvalPublicKeyPath: PUBLIC_KEY },
  };
}

describe("real publisher replication-only control flow (offline)", () => {
  it.each([true, false])(
    "reconciles an existing root only when its bytes match (%s)",
    async (matches) => {
      const { live, prepared } = await signedFixture();
      const request = JSON.parse(fixture.files.get(prepared.approvalRequestPath).toString());
      const root = request.target.primaryCars.root;
      const bytes = Buffer.from(fixture.files.get(path.join(PUBLISH, "cars", `${RUN}.car`)));
      if (!matches) bytes[0] ^= 255;
      fixture.objects.set(`${request.target.bucket}/${root.key}`, bytes);
      if (matches) {
        const result = await publishRun(live);
        expect(result.publicationState).toBe("REPLICATION_REQUESTS_RECORDED");
        expect(fixture.puts).toHaveBeenCalledTimes(2);
        expect(fixture.puts.mock.calls.every(([input]) => input.Key !== root.key)).toBe(true);
      } else {
        await expect(publishRun(live)).rejects.toThrow(/different bytes/);
        expect(fixture.puts).not.toHaveBeenCalled();
        expect(fixture.registrations).toHaveLength(0);
        expect((await readPublicationLedger(LEDGER)).attempts[request.attemptId].state).toBe(
          "AUTHORIZED",
        );
      }
      expect(fixture.objects.get(`${request.target.bucket}/${root.key}`)).toEqual(bytes);
      expect(fixture.gateway).not.toHaveBeenCalled();
      expect((await readPublicationLedger(LEDGER)).consumedApprovals).toEqual([]);
    },
  );

  it.each(["expiry", "pointer"])(
    "rechecks the actual %s guard after asynchronous absent-object GET",
    async (kind) => {
      const { live } = await signedFixture();
      fixture.getHook = async () => {
        if (kind === "expiry") vi.setSystemTime(new Date("2026-09-16T23:00:00.000Z"));
        else fixture.predecessor = computeRawCid("changed offline predecessor");
      };
      await expect(publishRun(live)).rejects.toThrow(kind === "expiry" ? /expir/i : /predecessor/i);
      expect(fixture.puts).not.toHaveBeenCalled();
      expect(fixture.registrations).toHaveLength(0);
      expect(fixture.gateway).not.toHaveBeenCalled();
      const ledger = await readPublicationLedger(LEDGER);
      expect(Object.values(ledger.attempts).at(-1).state).toBe("AUTHORIZED");
      expect(ledger.consumedApprovals).toEqual([]);
    },
  );

  it.each([true, false, "cidv0"])(
    "records three %s registrations/accepted requests and stops before every promotion effect",
    async (registered) => {
      fixture.registered = registered;
      const { live } = await signedFixture();
      const before = protectedPaths.map((name) => Buffer.from(fixture.files.get(name)));
      const result = await publishRun(live);
      expect(result).toMatchObject({
        executionScope: "replication-only",
        publicationState: "REPLICATION_REQUESTS_RECORDED",
        retentionVerified: false,
        promotionHeld: true,
        nextAction: "review-provider-retention-evidence",
      });
      expect(result).not.toHaveProperty("status", "succeeded");
      expect(fixture.puts).toHaveBeenCalledTimes(3);
      for (const [command] of fixture.puts.mock.calls) expect(command.IfNoneMatch).toBe("*");
      expect(fixture.registrations).toHaveLength(3);
      for (const kind of ["root", "manifest", "archive"])
        expect(result.evidence[kind].status).toBe(
          registered ? "registration-reconciled" : "request-accepted",
        );
      expect(JSON.stringify(result)).not.toContain("responseBody");
      expect(fixture.gateway).not.toHaveBeenCalled();
      expect(fixture.env).not.toHaveBeenCalled();
      const ledger = await readPublicationLedger(LEDGER);
      expect(ledger.consumedApprovals).toEqual([]);
      expect(ledger.attempts[result.attemptId].transitions.map((entry) => entry.stage)).toEqual([
        "PREPARED",
        "FROZEN",
        "BUILT",
        "AUTHORIZED",
        "ROOT_UPLOAD_RECORDED",
        "MANIFEST_UPLOAD_RECORDED",
        "REPLICATION_REQUESTS_RECORDED",
      ]);
      protectedPaths.forEach((name, index) =>
        expect(fixture.files.get(name)).toEqual(before[index]),
      );
      expect(fixture.writes.filter((name) => protectedPaths.includes(name))).toEqual([]);
      expect(
        fixture.writes.filter(
          (name) =>
            !name.startsWith(`${PUBLISH}/`) && name !== LEDGER && !name.startsWith(`${LEDGER}.`),
        ),
      ).toEqual([]);
      globalThis.fetch.mockClear();
      fixture.puts.mockClear();
      fixture.writes.length = 0;
      vi.setSystemTime(new Date("2026-09-17T21:00:00.000Z"));
      const resumed = await publishRun({ ...live, envFile: "/must-not-read.env" });
      expect(resumed).toEqual(result);
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(fixture.puts).not.toHaveBeenCalled();
      expect(fixture.env).not.toHaveBeenCalled();
      expect(fixture.writes).toEqual([]);
    },
  );

  it("rejects a full-scope signature before loading credentials or making requests", async () => {
    const { live } = await signedFixture("full");
    await expect(publishRun({ ...live, envFile: "/must-not-read.env" })).rejects.toThrow(
      /exact target/,
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(fixture.puts).not.toHaveBeenCalled();
    expect(fixture.env).not.toHaveBeenCalled();
  });

  it("recovers interrupted request intent without repeating POST or claiming acceptance", async () => {
    const { live } = await signedFixture();
    const handler = globalThis.fetch.getMockImplementation();
    let interrupted = false;
    globalThis.fetch.mockImplementation(async (input, options) => {
      if (!interrupted && options?.method === "POST") {
        interrupted = true;
        throw new Error("offline connection interrupted after request intent");
      }
      return handler(input, options);
    });
    await expect(publishRun(live)).rejects.toThrow(/interrupted/);
    const result = await publishRun(live);
    expect(result.evidence.root).toMatchObject({
      status: "request-outcome-uncertain",
      requestAccepted: null,
      retentionVerified: false,
    });
    expect(fixture.registrations).toHaveLength(2);
    expect(fixture.puts).toHaveBeenCalledTimes(3);
    const rootPosts = globalThis.fetch.mock.calls.filter(
      ([, options]) =>
        options?.method === "POST" && JSON.parse(options.body).fileName.endsWith("/root"),
    );
    expect(rootPosts).toHaveLength(1);
    expect(fixture.gateway).not.toHaveBeenCalled();
    expect((await readPublicationLedger(LEDGER)).consumedApprovals).toEqual([]);
  });

  it("does not treat a bounded terminal receipt as authority to retry remotely under full scope", async () => {
    const { live } = await signedFixture();
    await publishRun(live);
    globalThis.fetch.mockClear();
    fixture.puts.mockClear();
    await expect(publishRun({ ...live, executionScope: undefined })).rejects.toThrow(
      /exact target/,
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(fixture.puts).not.toHaveBeenCalled();
  });

  it("rejects unknown scopes before even consulting provenance", async () => {
    await expect(publishRun({ ...OPTIONS, executionScope: "full" })).rejects.toThrow(
      /execution scope/,
    );
    expect(fixture.provenance).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
