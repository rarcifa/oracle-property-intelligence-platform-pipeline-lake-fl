/**
 * Gateway selection.
 *
 * The read path pinned one vendor gateway — `ipfs.filebase.io`, the same vendor
 * that pins the data — which put the runtime in tension with this project's own
 * rule that a vendor-specific HTTP URL is not the source of truth, and made the
 * no-ongoing-cost claim depend on one account staying live. The CID is the
 * source of truth; a gateway is transport, and transport is allowed to fail.
 */
import { describe, expect, it } from "vitest";
import {
  IPFS_GATEWAYS,
  RANGE_READ_GATEWAYS,
  gatewayOf,
  parquetCandidates,
  parquetUrl,
} from "./gateways.js";

const ROOT = "bafybeiay65owaalyfthqnyfsmr47xmyl5bf373bylai757kbrn62rgz33q";

describe("range-read gateways", () => {
  it("offers more than one, so a single vendor cannot take the runtime down", () => {
    expect(RANGE_READ_GATEWAYS.length).toBeGreaterThan(1);
  });

  it("only lists gateways recorded as supporting both CORS and Range", () => {
    for (const gateway of RANGE_READ_GATEWAYS) {
      expect(gateway.cors).toBe(true);
      expect(gateway.range).toBe(true);
    }
  });

  it("keeps every range-read gateway in the registry", () => {
    for (const gateway of RANGE_READ_GATEWAYS) {
      expect(IPFS_GATEWAYS.map((entry) => entry.id)).toContain(gateway.id);
    }
  });
});

describe("parquetCandidates", () => {
  it("returns one URL per range-read gateway, preferred first", () => {
    const candidates = parquetCandidates(ROOT);
    expect(candidates).toHaveLength(RANGE_READ_GATEWAYS.length);
    expect(candidates[0]).toBe(parquetUrl(ROOT));
    for (const url of candidates) expect(url).toContain(`/ipfs/${ROOT}/query-table.parquet`);
  });

  it("puts a caller's preferred URL first without dropping the fallbacks", () => {
    const preferred = "https://gw.ipfs-lens.dev/ipfs/x/query-table.parquet";
    const candidates = parquetCandidates(ROOT, preferred);
    expect(candidates[0]).toBe(preferred);
    expect(candidates.length).toBeGreaterThan(1);
    expect(new Set(candidates).size).toBe(candidates.length);
  });

  it("never yields duplicates when the preferred URL is already a candidate", () => {
    const candidates = parquetCandidates(ROOT, parquetUrl(ROOT));
    expect(new Set(candidates).size).toBe(candidates.length);
  });
});

describe("gatewayOf", () => {
  it("names the gateway serving a URL, for reporting which one is in use", () => {
    expect(gatewayOf(parquetUrl(ROOT))?.id).toBe(RANGE_READ_GATEWAYS[0]!.id);
  });

  it("returns null for a URL from no known gateway", () => {
    expect(gatewayOf("https://example.com/ipfs/x/query-table.parquet")).toBeNull();
  });
});
