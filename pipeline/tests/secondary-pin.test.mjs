import { describe, expect, it, vi } from "vitest";

import {
  ensureSecondaryPin,
  validateSecondaryPinServiceEndpoint,
} from "../src/core/secondary-pin.mjs";

const CID = "bafybeih5xrlpzdvjoky75aq7j2cad36dnnzec4suqiwboy3ucayjgyeqnq";
const NAME = "oracle-open-data-lake/20260911T131000Z/root";

function reply(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function pin(status = "pinned") {
  return { requestid: "secondary-request-1", status, pin: { cid: CID, name: NAME } };
}

describe("independent secondary IPFS pin", () => {
  it("rejects insecure and primary-vendor endpoints before upload", () => {
    expect(() => validateSecondaryPinServiceEndpoint("http://pins.example.test/v1")).toThrow(
      /HTTPS/,
    );
    expect(() =>
      validateSecondaryPinServiceEndpoint("https://ipfs.filebase.io/v1"),
    ).toThrow(/independent/);
  });

  it("reconciles an existing deterministic pin without creating another", async () => {
    const fetchImpl = vi.fn(async () => reply({ count: 1, results: [pin()] }));
    const beforeCreate = vi.fn();
    const receipt = await ensureSecondaryPin({
      endpoint: "https://pins.example.test/v1",
      token: "secret-token",
      cid: CID,
      name: NAME,
      fetchImpl,
      beforeCreate,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(beforeCreate).not.toHaveBeenCalled();
    expect(receipt).toEqual({
      serviceHost: "pins.example.test",
      requestId: "secondary-request-1",
      cid: CID,
      name: NAME,
      status: "pinned",
    });
    expect(JSON.stringify(receipt)).not.toContain("secret-token");
  });

  it("creates once, polls to pinned, and checks authority immediately before creation", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(reply({ count: 0, results: [] }))
      .mockResolvedValueOnce(reply(pin("queued"), 202))
      .mockResolvedValueOnce(reply(pin("pinning")))
      .mockResolvedValueOnce(reply(pin("pinned")));
    const beforeCreate = vi.fn();
    const sleep = vi.fn(async () => {});
    await expect(
      ensureSecondaryPin({
        endpoint: "https://pins.example.test/v1/",
        token: "secret-token",
        cid: CID,
        name: NAME,
        fetchImpl,
        beforeCreate,
        sleep,
        attempts: 3,
        intervalMs: 1,
      }),
    ).resolves.toMatchObject({ status: "pinned", cid: CID });
    expect(beforeCreate).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(1);
    const create = fetchImpl.mock.calls[1];
    expect(create?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(create?.[1]?.body))).toEqual({ cid: CID, name: NAME });
  });

  it("fails closed on a mismatched or failed provider response", async () => {
    const mismatch = vi.fn(async () =>
      reply({ count: 1, results: [{ ...pin(), pin: { cid: "bafywrong", name: NAME } }] }),
    );
    await expect(
      ensureSecondaryPin({
        endpoint: "https://pins.example.test/v1",
        token: "secret-token",
        cid: CID,
        name: NAME,
        fetchImpl: mismatch,
      }),
    ).rejects.toThrow();

    const failed = vi
      .fn()
      .mockResolvedValueOnce(reply({ count: 1, results: [pin("failed")] }))
      .mockResolvedValueOnce(reply(pin("failed")));
    await expect(
      ensureSecondaryPin({
        endpoint: "https://pins.example.test/v1",
        token: "secret-token",
        cid: CID,
        name: NAME,
        fetchImpl: failed,
        attempts: 1,
      }),
    ).rejects.toThrow(/failed request/);
  });
});
