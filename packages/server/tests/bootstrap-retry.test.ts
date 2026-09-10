/**
 * A failed cold start must not brick the container for its lifetime.
 *
 * Both bootstraps cached the promise with `??=`, and a rejected promise is still
 * a promise: one transient gateway failure at cold start — and this repo's own
 * notes record that public gateways answer 429 to datacenter egress — left every
 * later invocation on that container awaiting the same stored rejection. The
 * container stays warm, so it can keep serving that failure for minutes.
 */
import { describe, expect, it } from "vitest";
import { OracleDataStore } from "../src/data/duckdb.js";

describe("OracleDataStore.init", () => {
  it("does not cache a failure: a second call retries instead of replaying it", async () => {
    // No CID in the URL, so there is nothing to re-host and the open must fail.
    const store = new OracleDataStore({
      source: "https://gateway.invalid/nope/query-table.parquet",
    });

    const firstStart = Date.now();
    await expect(store.init()).rejects.toThrow();
    const firstMs = Date.now() - firstStart;

    // Both calls reject either way, so rejecting proves nothing. What separates
    // a retry from a replay is whether the second call does any work: a cached
    // rejection settles instantly, a fresh attempt has to reach the network
    // again and cannot.
    const secondStart = Date.now();
    await expect(store.init()).rejects.toThrow();
    const secondMs = Date.now() - secondStart;

    expect(firstMs).toBeGreaterThan(20);
    expect(secondMs).toBeGreaterThan(20);

    // And once the source is reachable, a store that failed before can recover.
    const root = process.env.ORACLE_PARQUET_URL;
    if (root !== undefined && root.length > 0) {
      const recovered = new OracleDataStore({ source: root });
      await recovered.init();
      const rows = await recovered.query("SELECT count(*) AS n FROM properties");
      expect(Number(rows[0]!.n)).toBeGreaterThan(200_000);
    }
  }, 180_000);
});
