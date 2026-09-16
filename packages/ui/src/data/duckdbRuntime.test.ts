import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ selectBundle: vi.fn() }));
vi.mock("@duckdb/duckdb-wasm", () => ({
  selectBundle: mocks.selectBundle,
  getJsDelivrBundles: () => ({}),
  ConsoleLogger: class {},
  LogLevel: { WARNING: 1 },
  AsyncDuckDB: class {
    instantiate = vi.fn(async () => undefined);
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
  vi.stubGlobal(
    "Worker",
    class {
      terminate = vi.fn();
    },
  );
});
afterEach(() => {
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
});
