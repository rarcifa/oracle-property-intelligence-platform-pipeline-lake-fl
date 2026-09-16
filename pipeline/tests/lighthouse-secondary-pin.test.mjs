import { mkdtemp, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CID } from "multiformats/cid";

import { computeRawCid, computeUnixfsFileCid } from "../src/core/cid.mjs";
import {
  assertSecondaryRetention,
  ensureLighthouseRegistration,
  findLighthouseRegistration,
  writeLighthouseCheckpoint,
} from "../src/core/secondary-pin.mjs";

const ENDPOINT = "https://api.lighthouse.storage";
const OBJECT = computeRawCid("object");
const NAME = "oracle-open-data-lake/20260916T181000Z/manifest";
const TOKEN = "private-lighthouse-key";
const OPTIONS = { endpoint: ENDPOINT, token: TOKEN, cid: OBJECT, name: NAME };
const entry = (overrides = {}) => ({
  id: "file-1",
  cid: OBJECT,
  fileName: NAME,
  fileSizeInBytes: "6",
  encryption: false,
  ...overrides,
});
const info = (overrides = {}) => ({
  cid: OBJECT,
  fileSizeInBytes: "6",
  encryption: false,
  ...overrides,
});
const inventory = (entries = []) => ({ fileList: entries, totalFiles: entries.length });
const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.restoreAllMocks());

describe("Lighthouse same-CID registration (not retention proof)", () => {
  it("reconciles inventory and metadata without POST or invented pinned status", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(reply(inventory([entry()])))
      .mockResolvedValueOnce(reply(info()));
    const beforeCreate = vi.fn();
    const receipt = await ensureLighthouseRegistration({
      ...OPTIONS,
      fetchImpl,
      beforeCreate,
      expectedBytes: 6,
    });
    expect(beforeCreate).not.toHaveBeenCalled();
    expect(receipt).toMatchObject({
      status: "registration-reconciled",
      retentionVerified: false,
      requestAccepted: null,
      registration: { id: "file-1" },
    });
    expect(JSON.stringify(receipt)).not.toContain(TOKEN);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      redirect: "error",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(fetchImpl.mock.calls[1][1]).toMatchObject({ redirect: "error" });
    expect(fetchImpl.mock.calls[1][1].headers).toBeUndefined();
    expect(() => assertSecondaryRetention([receipt, receipt, receipt])).toThrow(
      /not verified IPFS retention/,
    );
  });

  it("records intent, checks authority, uses the official request and preserves acceptance separately", async () => {
    const order = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(reply(inventory()))
      .mockImplementationOnce(async () => {
        order.push("POST");
        return reply({ message: "accepted" }, 202);
      })
      .mockResolvedValueOnce(reply(inventory()))
      .mockResolvedValueOnce(reply(inventory([entry()])))
      .mockResolvedValueOnce(reply(info()));
    const onEvidence = vi.fn(async (receipt) => {
      order.push(receipt.status);
    });
    const beforeCreate = vi.fn(async () => {
      order.push("authority");
    });
    const sleep = vi.fn(async () => {});
    const receipt = await ensureLighthouseRegistration({
      ...OPTIONS,
      fetchImpl,
      onEvidence,
      beforeCreate,
      sleep,
      attempts: 2,
      intervalMs: 0,
    });
    expect(order).toEqual([
      "request-submitting",
      "authority",
      "POST",
      "request-accepted",
      "registration-reconciled",
    ]);
    expect(fetchImpl.mock.calls[1][0]).toBe(`${ENDPOINT}/api/lighthouse/pin`);
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({ cid: OBJECT, fileName: NAME });
    expect(receipt.requestAccepted).toMatchObject({
      state: "request-accepted",
      httpStatus: 202,
      responseDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(receipt.retentionVerified).toBe(false);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("resumes an interrupted request without blindly repeating POST", async () => {
    const fetchImpl = vi.fn(async () => reply(inventory()));
    const beforeCreate = vi.fn();
    await expect(
      ensureLighthouseRegistration({
        ...OPTIONS,
        fetchImpl,
        beforeCreate,
        attempts: 1,
        previousEvidence: {
          ...OPTIONS,
          token: undefined,
          serviceHost: "api.lighthouse.storage",
          provider: "lighthouse",
          requestIntent: { state: "request-submitting" },
          requestAccepted: null,
        },
      }),
    ).rejects.toThrow(/not reconciled/);
    expect(fetchImpl.mock.calls.every(([, options]) => options.method !== "POST")).toBe(true);
    expect(beforeCreate).not.toHaveBeenCalled();
  });

  it("rejects checkpoint drift before any network or authority check", async () => {
    const fetchImpl = vi.fn();
    await expect(
      ensureLighthouseRegistration({
        ...OPTIONS,
        fetchImpl,
        previousEvidence: {
          provider: "lighthouse",
          cid: OBJECT,
          name: "other",
          serviceHost: "api.lighthouse.storage",
          requestIntent: { state: "request-submitting" },
        },
      }),
    ).rejects.toThrow(/checkpoint/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("resumes an accepted request without repeating POST and preserves its acknowledgement", async () => {
    const previousEvidence = {
      serviceHost: "api.lighthouse.storage",
      provider: "lighthouse",
      cid: OBJECT,
      name: NAME,
      requestAccepted: {
        state: "request-accepted",
        httpStatus: 202,
        responseDigest: `sha256:${"1".repeat(64)}`,
        responseBody: "accepted",
      },
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(reply(inventory([entry()])))
      .mockResolvedValueOnce(reply(info()));
    const receipt = await ensureLighthouseRegistration({ ...OPTIONS, previousEvidence, fetchImpl });
    expect(receipt.requestAccepted).toEqual(previousEvidence.requestAccepted);
    expect(fetchImpl.mock.calls.every(([, options]) => options.method !== "POST")).toBe(true);
  });

  it("redacts echoed credentials from the private acknowledgement", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(reply(inventory()))
      .mockResolvedValueOnce(reply({ message: TOKEN }))
      .mockResolvedValueOnce(reply(inventory([entry()])))
      .mockResolvedValueOnce(reply(info()));
    const receipt = await ensureLighthouseRegistration({ ...OPTIONS, fetchImpl });
    expect(receipt.requestAccepted.bodyRedacted).toBe(true);
    expect(JSON.stringify(receipt)).not.toContain(TOKEN);
    expect(receipt.requestAccepted.responseBody).toContain("[REDACTED]");
  });

  it("leaves an interrupted-request checkpoint on HTTP failure rather than claiming acceptance", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(reply(inventory()))
      .mockResolvedValueOnce(reply({ secret: TOKEN }, 500));
    const onEvidence = vi.fn(async () => {});
    await expect(
      ensureLighthouseRegistration({ ...OPTIONS, fetchImpl, onEvidence }),
    ).rejects.toThrow("HTTP 500");
    expect(onEvidence).toHaveBeenCalledOnce();
    expect(onEvidence.mock.calls[0][0]).toMatchObject({
      status: "request-submitting",
      requestAccepted: null,
      retentionVerified: false,
    });
    expect(JSON.stringify(onEvidence.mock.calls)).not.toContain(TOKEN);
  });

  it.each(["inventory", "POST", "metadata"])(
    "bounds a hung %s request with an abort signal",
    async (step) => {
      const aborted = AbortSignal.abort(new DOMException("deadline", "TimeoutError"));
      const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(aborted);
      let calls = 0;
      const onEvidence = vi.fn(async () => {});
      const fetchImpl = vi.fn(async (url, options) => {
        calls += 1;
        expect(options.signal).toBe(aborted);
        const isTarget =
          step === "inventory" ||
          (step === "POST" && options.method === "POST") ||
          (step === "metadata" && String(url).includes("file_info"));
        if (isTarget) options.signal.throwIfAborted();
        return reply(inventory(step === "metadata" ? [entry()] : []));
      });
      await expect(
        ensureLighthouseRegistration({ ...OPTIONS, fetchImpl, onEvidence }),
      ).rejects.toThrow("deadline");
      expect(timeout.mock.calls.every(([milliseconds]) => milliseconds === 20_000)).toBe(true);
      expect(calls).toBe(step === "inventory" ? 1 : 2);
      expect(onEvidence).toHaveBeenCalledTimes(step === "POST" ? 1 : 0);
      if (step === "POST") expect(onEvidence.mock.calls[0][0].status).toBe("request-submitting");
    },
  );

  it("never creates if intent persistence or the immediate authority check fails", async () => {
    for (const failingStep of ["intent", "authority"]) {
      const fetchImpl = vi.fn(async () => reply(inventory()));
      const fail = async () => {
        throw new Error("held");
      };
      await expect(
        ensureLighthouseRegistration({
          ...OPTIONS,
          fetchImpl,
          onEvidence: failingStep === "intent" ? fail : async () => {},
          beforeCreate: failingStep === "authority" ? fail : async () => {},
        }),
      ).rejects.toThrow("held");
      expect(fetchImpl).toHaveBeenCalledOnce();
    }
  });

  it("rejects malformed inventory rather than interpreting it as permission to POST", async () => {
    const fetchImpl = vi.fn(async () => reply({ error: "unknown" }));
    await expect(ensureLighthouseRegistration({ ...OPTIONS, fetchImpl })).rejects.toThrow(
      /invalid inventory/,
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects failed authentication without displaying the response/token", async () => {
    const fetchImpl = vi.fn(async () => reply({ echoedSecret: TOKEN }, 403));
    await expect(ensureLighthouseRegistration({ ...OPTIONS, fetchImpl })).rejects.toThrow(
      "HTTP 403",
    );
    await expect(ensureLighthouseRegistration({ ...OPTIONS, fetchImpl })).rejects.not.toThrow(
      TOKEN,
    );
  });

  it.each([
    { encryption: true },
    { encryption: undefined },
    { id: undefined },
    { fileSizeInBytes: "-1" },
    { fileSizeInBytes: "9007199254740992" },
  ])("rejects invalid registration metadata: %j", async (overrides) => {
    const fetchImpl = vi.fn(async () => reply(inventory([entry(overrides)])));
    await expect(ensureLighthouseRegistration({ ...OPTIONS, fetchImpl })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([{ cid: computeRawCid("different") }, { encryption: true }, { fileSizeInBytes: "7" }])(
    "rejects mismatched public metadata: %j",
    async (overrides) => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(reply(inventory([entry()])))
        .mockResolvedValueOnce(reply(info(overrides)));
      await expect(ensureLighthouseRegistration({ ...OPTIONS, fetchImpl })).rejects.toThrow(
        /does not match/,
      );
    },
  );

  it("checks expected file bytes rather than trusting two equally wrong provider sizes", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(reply(inventory([entry()])))
      .mockResolvedValueOnce(reply(info()));
    await expect(
      ensureLighthouseRegistration({ ...OPTIONS, fetchImpl, expectedBytes: 7 }),
    ).rejects.toThrow(/does not match/);
  });

  it("recognizes CIDv0 notation of the exact same dag-pb DAG, not a different CID", async () => {
    const dag = computeUnixfsFileCid(Buffer.alloc(300_000));
    const cidV0 = CID.parse(dag.cid).toV0().toString();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(reply(inventory([entry({ cid: cidV0 })])))
      .mockResolvedValueOnce(reply(info({ cid: cidV0 })));
    const receipt = await ensureLighthouseRegistration({ ...OPTIONS, cid: dag.cid, fetchImpl });
    expect(receipt.cid).toBe(dag.cid);
    expect(receipt.registration.cid).toBe(cidV0);
  });

  it("rejects ambiguous exact registrations", async () => {
    const fetchImpl = vi.fn(async () => reply(inventory([entry(), entry({ id: "file-2" })])));
    await expect(findLighthouseRegistration({ ...OPTIONS, fetchImpl })).rejects.toThrow(
      /ambiguous/,
    );
  });

  it("paginates a full page before deciding no registration exists", async () => {
    const first = Array.from({ length: 2000 }, (_, i) =>
      entry({ id: `other-${i}`, fileName: "other" }),
    );
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(reply(inventory(first)))
      .mockResolvedValueOnce(reply(inventory([entry()])));
    expect(await findLighthouseRegistration({ ...OPTIONS, fetchImpl })).toMatchObject({
      id: "file-1",
    });
    expect(new URL(fetchImpl.mock.calls[1][0]).searchParams.get("lastKey")).toBe("other-1999");
  });

  it("fails closed on pagination loops and exhausted page bounds", async () => {
    const first = Array.from({ length: 2000 }, (_, i) =>
      entry({ id: `other-${i}`, fileName: "other" }),
    );
    const fetchImpl = vi.fn(async () => reply(inventory(first)));
    await expect(
      findLighthouseRegistration({ ...OPTIONS, fetchImpl, maxPages: 1 }),
    ).rejects.toThrow(/page limit/);
    await expect(findLighthouseRegistration({ ...OPTIONS, fetchImpl })).rejects.toThrow(
      /did not advance/,
    );
  });

  it.each([
    "https://api.lighthouse.storage/",
    "https://api.lighthouse.storage/psa",
    "https://api.pinata.cloud/psa",
    "https://evil.example",
  ])('rejects unapproved endpoint "%s" without touching credentials/network', async (endpoint) => {
    const fetchImpl = vi.fn();
    await expect(ensureLighthouseRegistration({ ...OPTIONS, endpoint, fetchImpl })).rejects.toThrow(
      /must exactly equal/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("allows the existing actual PSA pinned receipts, not empty/partial receipts", () => {
    expect(() =>
      assertSecondaryRetention([{ status: "pinned" }, { status: "pinned" }, { status: "pinned" }]),
    ).not.toThrow();
    expect(() => assertSecondaryRetention([])).toThrow();
    expect(() => assertSecondaryRetention([null, null, null])).toThrow();
    expect(() =>
      assertSecondaryRetention(
        [{ status: "pinned" }, { status: "pinned" }, { status: "pinned" }],
        "lighthouse",
      ),
    ).toThrow(/not verified IPFS retention/);
    expect(() =>
      assertSecondaryRetention(
        [{ status: "pinned" }, { status: "pinned" }, { status: "pinned" }],
        "unknown",
      ),
    ).toThrow();
  });
});

describe("private Lighthouse checkpoints", () => {
  it("atomically replaces complete JSON and keeps owner-only permissions", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "oracle-lighthouse-checkpoint-"));
    try {
      const checkpoint = path.join(directory, "receipt.json");
      await writeLighthouseCheckpoint(checkpoint, { status: "request-submitting" });
      await writeLighthouseCheckpoint(checkpoint, { status: "request-accepted" });
      expect(JSON.parse(await readFile(checkpoint, "utf8"))).toEqual({
        status: "request-accepted",
      });
      expect((await stat(checkpoint)).mode & 0o777).toBe(0o600);
      expect(await readdir(directory)).toEqual(["receipt.json"]);
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  it.each(["write", "rename"])(
    "preserves the last complete checkpoint on %s failure",
    async (step) => {
      const directory = await mkdtemp(path.join(tmpdir(), "oracle-lighthouse-checkpoint-"));
      try {
        const checkpoint = path.join(directory, "receipt.json");
        await writeLighthouseCheckpoint(checkpoint, { status: "request-submitting" });
        const fileOperations = {
          writeFile:
            step === "write"
              ? async (temporaryPath, _data, options) => {
                  await writeFile(temporaryPath, "{", options);
                  throw new Error("interrupted write");
                }
              : writeFile,
          rename:
            step === "rename"
              ? async () => {
                  throw new Error("interrupted rename");
                }
              : rename,
          unlink,
        };
        await expect(
          writeLighthouseCheckpoint(checkpoint, { status: "request-accepted" }, fileOperations),
        ).rejects.toThrow(`interrupted ${step}`);
        expect(JSON.parse(await readFile(checkpoint, "utf8"))).toEqual({
          status: "request-submitting",
        });
        expect(await readdir(directory)).toEqual(["receipt.json"]);
      } finally {
        await rm(directory, { recursive: true });
      }
    },
  );
});
