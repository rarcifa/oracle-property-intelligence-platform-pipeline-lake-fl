import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  selectBundle: vi.fn(),
  instantiate: vi.fn(),
  terminate: vi.fn(),
  workerTerminate: vi.fn(),
}));
vi.mock("@duckdb/duckdb-wasm", () => ({
  selectBundle: mocks.selectBundle,
  getJsDelivrBundles: () => ({}),
  ConsoleLogger: class {},
  LogLevel: { WARNING: 1 },
  AsyncDuckDB: class {
    instantiate = mocks.instantiate;
    terminate = mocks.terminate;
    constructor(
      _logger: unknown,
      readonly worker: unknown,
    ) {}
  },
}));

beforeEach(() => {
  vi.resetModules();
  mocks.selectBundle
    .mockReset()
    .mockResolvedValue({ mainWorker: "synthetic-worker", mainModule: "synthetic-module" });
  mocks.instantiate.mockReset().mockResolvedValue(undefined);
  mocks.terminate.mockReset().mockResolvedValue(undefined);
  mocks.workerTerminate.mockReset();
  vi.stubGlobal(
    "Worker",
    class {
      terminate = vi.fn(() => mocks.workerTerminate());
    },
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("DuckDB worker ownership", () => {
  it("reuses only the unclaimed prewarm, not another source's worker", async () => {
    const { warmDuckDbRuntime, takeDuckDbRuntime } = await import("./duckdbSource.js");
    const warm = warmDuckDbRuntime();
    expect(warmDuckDbRuntime()).toBe(warm);
    expect(takeDuckDbRuntime()).toBe(warm);
    const oldRuntime = await warm;
    const replacement = await takeDuckDbRuntime();
    expect(replacement.worker).not.toBe(oldRuntime.worker);
    expect(replacement.db).not.toBe(oldRuntime.db);
    oldRuntime.worker.terminate();
    expect(replacement.worker.terminate).not.toHaveBeenCalled();
    URL.revokeObjectURL(oldRuntime.workerUrl);
    URL.revokeObjectURL(replacement.workerUrl);
  });
  it("does not cache a failed warm-up", async () => {
    mocks.selectBundle.mockRejectedValueOnce(new Error("synthetic boot failure"));
    const { warmDuckDbRuntime, takeDuckDbRuntime } = await import("./duckdbSource.js");
    await expect(warmDuckDbRuntime()).rejects.toThrow("synthetic boot failure");
    const replacement = await takeDuckDbRuntime();
    expect(mocks.selectBundle).toHaveBeenCalledTimes(2);
    URL.revokeObjectURL(replacement.workerUrl);
  });
  it("an old failed source cannot clear a newer pending prewarm", async () => {
    let rejectOld!: (error: Error) => void;
    mocks.selectBundle.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectOld = reject;
        }),
    );
    const { warmDuckDbRuntime, takeDuckDbRuntime } = await import("./duckdbSource.js");
    const old = takeDuckDbRuntime();
    const rejection = expect(old).rejects.toThrow("old boot failure");
    const newer = warmDuckDbRuntime();
    rejectOld(new Error("old boot failure"));
    await rejection;
    expect(warmDuckDbRuntime()).toBe(newer);
    const replacement = await takeDuckDbRuntime();
    URL.revokeObjectURL(replacement.workerUrl);
  });
  it("releases a worker and blob URL when WASM instantiation fails", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    mocks.instantiate.mockRejectedValueOnce(new Error("synthetic WASM failure"));
    const { takeDuckDbRuntime } = await import("./duckdbSource.js");
    await expect(takeDuckDbRuntime()).rejects.toThrow("synthetic WASM failure");
    expect(mocks.terminate).toHaveBeenCalledOnce();
    expect(mocks.workerTerminate).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledOnce();
  });
  it("releases a late successful boot after its caller has timed out", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    mocks.instantiate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const { createDuckDbSource } = await import("./duckdbSource.js");
    const attempt = createDuckDbSource({
      rootCid: "bafybeigakr7d6nywkbanzmh4r7cpv7kz7qs5vxvwlxcxuovk2lobrj442u",
      runId: "synthetic-public-run",
      timeoutMs: 10,
    });
    const rejected = expect(attempt).rejects.toThrow("timed out after 10 ms");
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    expect(mocks.workerTerminate).not.toHaveBeenCalled();
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.terminate).toHaveBeenCalledOnce();
    expect(mocks.workerTerminate).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledOnce();
  });
});
