/** Real AWS serialization/stream fixtures with an in-process handler; zero network calls. */
import { Readable } from "node:stream";
import { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { uploadImmutableCar } from "../scripts/lake/publish-run.mjs";
import { computeRawCid } from "../src/core/cid.mjs";
import { sha256Digest } from "../src/core/publish-gate.mjs";

const BODY = Buffer.from("frozen immutable CAR bytes");
const CID = computeRawCid(BODY);
const missing = (statusCode = 404, code = "NoSuchKey") => ({
  response: {
    statusCode,
    headers: { "content-type": "application/xml" },
    body: Readable.from([`<Error><Code>${code}</Code></Error>`]),
  },
});
const object = (body = BODY, overrides = {}) => ({
  response: {
    statusCode: 200,
    headers: { "content-length": String(BODY.length), "x-amz-meta-cid": CID, ...overrides },
    body: body instanceof Readable ? body : Readable.from([body]),
  },
});

async function withClient(handle, test) {
  const requests = [];
  // No mocked AWS SDK: serialize, sign with dummy credentials and deserialize real streams.
  const client = new S3Client({
    endpoint: "https://offline.invalid",
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: "OFFLINE_ONLY", secretAccessKey: "OFFLINE_ONLY" },
    maxAttempts: 1,
    requestHandler: {
      handle: async (request, options) => {
        requests.push(request);
        return handle(request, options);
      },
      destroy() {},
    },
  });
  const beforeCreate = vi.fn(async () => {});
  try {
    await test({
      client,
      requests,
      beforeCreate,
      options: {
        client,
        bucket: "offline-fixture",
        key: "runs/fixture/root.car",
        body: BODY,
        expectedCid: CID,
        beforeCreate,
      },
    });
  } finally {
    client.destroy();
  }
}

describe("immutable CAR reconciliation contract (real SDK, offline)", () => {
  it("fully verifies a multi-chunk existing object with zero PUTs and unchanged receipts", async () => {
    await withClient(
      () => object(Readable.from([BODY.subarray(0, 4), BODY.subarray(4)])),
      async ({ options, requests, beforeCreate }) => {
        await expect(uploadImmutableCar(options)).resolves.toEqual({
          action: "reconciled-existing",
          key: options.key,
          bytes: BODY.length,
          sha256: sha256Digest(BODY),
          reportedCid: CID,
        });
        expect(requests.map((request) => request.method)).toEqual(["GET"]);
        expect(requests[0].headers.range).toBeUndefined();
        expect(beforeCreate).not.toHaveBeenCalled();
      },
    );
  });

  it.each(["different", "truncated", "oversized", "socket-close", "wrong-length", "wrong-cid"])(
    "rejects %s existing bytes without PUT or receipt",
    async (kind) => {
      let stream;
      let response;
      if (kind === "socket-close") {
        stream = Readable.from(
          (async function* () {
            yield BODY.subarray(0, 4);
            throw Object.assign(new Error("DO_NOT_LOG_SECRET"), { code: "ECONNRESET" });
          })(),
        );
        response = object(stream);
      } else {
        const bytes =
          kind === "different"
            ? Buffer.alloc(BODY.length, 1)
            : kind === "truncated"
              ? BODY.subarray(0, 4)
              : kind === "oversized"
                ? Buffer.concat([BODY, Buffer.from("extra")])
                : BODY;
        stream = Readable.from([bytes]);
        response = object(
          stream,
          kind === "wrong-length"
            ? { "content-length": "4" }
            : kind === "wrong-cid"
              ? { "x-amz-meta-cid": computeRawCid("different") }
              : {},
        );
      }
      await withClient(
        () => response,
        async ({ options, requests, beforeCreate }) => {
          const error = await uploadImmutableCar(options).catch((value) => value);
          expect(error).toBeInstanceOf(Error);
          expect(error.message).not.toContain("DO_NOT_LOG_SECRET");
          if (["truncated", "socket-close"].includes(kind))
            expect(error.message).toContain(`expected=${BODY.length} received=4`);
          expect(stream.destroyed).toBe(true);
          expect(requests.map((request) => request.method)).toEqual(["GET"]);
          expect(beforeCreate).not.toHaveBeenCalled();
        },
      );
    },
  );

  it.each([403, 500])(
    "does not create after HTTP %s, even if an error code says NoSuchKey",
    async (status) => {
      await withClient(
        () => missing(status),
        async ({ options, requests }) => {
          await expect(uploadImmutableCar(options)).rejects.toThrow(/GET failed before body/);
          expect(requests.map((request) => request.method)).toEqual(["GET"]);
        },
      );
    },
  );

  it("does not create after an unknown GET failure", async () => {
    await withClient(
      () => {
        throw new Error("DO_NOT_LOG_SECRET");
      },
      async ({ options, requests }) => {
        await expect(uploadImmutableCar(options)).rejects.toThrow(/received=0 status=unknown/);
        expect(requests.map((request) => request.method)).toEqual(["GET"]);
      },
    );
  });

  it("guards one conditional create only after definite absence, then verifies every byte", async () => {
    let created = false;
    let guardRan = false;
    await withClient(
      (request) => {
        if (request.method === "GET") return created ? object() : missing();
        expect(guardRan).toBe(true);
        expect(request.headers["if-none-match"]).toBe("*");
        expect(request.headers["x-amz-meta-import"]).toBe("car");
        expect(Buffer.from(request.body)).toEqual(BODY);
        created = true;
        return {
          response: {
            statusCode: 200,
            headers: { "x-amz-meta-cid": CID },
            body: Readable.from([]),
          },
        };
      },
      async ({ options, beforeCreate, requests }) => {
        beforeCreate.mockImplementation(async () => {
          guardRan = true;
        });
        await expect(uploadImmutableCar(options)).resolves.toMatchObject({
          action: "created",
          reportedCid: CID,
        });
        expect(beforeCreate).toHaveBeenCalledTimes(1);
        expect(requests.map((request) => request.method)).toEqual(["GET", "PUT", "GET"]);
      },
    );
  });

  it.each(["authorization expired", "predecessor changed"])(
    "creates nothing if the fresh guard detects %s",
    async (reason) => {
      await withClient(
        () => missing(),
        async ({ options, beforeCreate, requests }) => {
          beforeCreate.mockImplementation(async () => {
            throw new Error(reason);
          });
          await expect(uploadImmutableCar(options)).rejects.toThrow(reason);
          expect(requests.map((request) => request.method)).toEqual(["GET"]);
        },
      );
    },
  );

  it("never blindly retries a lost create acknowledgement; next invocation reconciles by GET", async () => {
    let created = false;
    await withClient(
      (request) => {
        if (request.method === "GET") return created ? object() : missing();
        created = true;
        throw Object.assign(new Error("DO_NOT_LOG_SECRET"), { name: "TimeoutError" });
      },
      async ({ options, requests }) => {
        await expect(uploadImmutableCar(options)).rejects.toThrow(/outcome uncertain/);
        expect(requests.map((request) => request.method)).toEqual(["GET", "PUT"]);
        await expect(uploadImmutableCar(options)).resolves.toMatchObject({
          action: "reconciled-existing",
        });
        expect(requests.map((request) => request.method)).toEqual(["GET", "PUT", "GET"]);
      },
    );
  });

  it("refuses creation on a client with implicit PUT retries enabled", async () => {
    await withClient(
      () => missing(),
      async ({ options, client, requests, beforeCreate }) => {
        client.config.maxAttempts = async () => 3;
        await expect(uploadImmutableCar(options)).rejects.toThrow(/maxAttempts=1/);
        expect(requests.map((request) => request.method)).toEqual(["GET"]);
        expect(beforeCreate).not.toHaveBeenCalled();
      },
    );
  });

  it.each(["truncated", "missing"])(
    "does not issue a receipt when post-create GET is %s",
    async (kind) => {
      let created = false;
      await withClient(
        (request) => {
          if (request.method === "GET")
            return !created || kind === "missing" ? missing() : object(BODY.subarray(0, 4));
          created = true;
          return { response: { statusCode: 200, headers: {}, body: Readable.from([]) } };
        },
        async ({ options, requests }) => {
          await expect(uploadImmutableCar(options)).rejects.toThrow(
            kind === "missing" ? /missing after create/ : /received=4/,
          );
          expect(requests.map((request) => request.method)).toEqual(["GET", "PUT", "GET"]);
        },
      );
    },
  );

  it("reconciles a create-time 412 by full GET instead of assuming provider atomicity", async () => {
    let gets = 0;
    await withClient(
      (request) =>
        request.method === "GET"
          ? ++gets === 1
            ? missing()
            : object()
          : missing(412, "PreconditionFailed"),
      async ({ options, requests }) => {
        await expect(uploadImmutableCar(options)).resolves.toMatchObject({
          action: "reconciled-existing",
        });
        expect(requests.map((request) => request.method)).toEqual(["GET", "PUT", "GET"]);
      },
    );
  });

  it("destroys a stalled body at the bounded deadline without creating", async () => {
    const stream = new Readable({ read() {} });
    stream.push(BODY.subarray(0, 4));
    await withClient(
      () => object(stream),
      async ({ options, requests }) => {
        await expect(uploadImmutableCar({ ...options, deadlineMs: 30 })).rejects.toThrow(
          /received=4 code=CAR_READ_TIMEOUT/,
        );
        expect(stream.destroyed).toBe(true);
        expect(requests.map((request) => request.method)).toEqual(["GET"]);
      },
    );
  });
});
