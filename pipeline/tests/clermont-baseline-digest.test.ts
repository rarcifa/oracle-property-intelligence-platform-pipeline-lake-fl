/** Publication must consume the certified runtime's exact baseline identity. */
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Text } from "../src/batch/contracts.js";
import { clermontBaselineSha256 } from "../scripts/lake/build-publish-set.mjs";

describe("Clermont baseline digest consumer parity", () => {
  it("matches runtime JSON encoding for nested arrays, nulls and nontrivial keys", () => {
    const fixtures = [
      null,
      { status: "certified", counts: { completed: 3, linked: 2, validUnlinked: 1 } },
      {
        Z: null,
        z: [{ Z: 2, a: 1, A: { "z-key": null, _prefix: "value" } }],
        "a-key": "nontrivial key ordering",
        A: false,
        a: [null, { "10": "ten", "2": "two", a: "lowercase", A: "uppercase" }],
      },
    ];
    for (const fixture of fixtures) {
      const runtimeBytes = canonicalJson(fixture);
      expect(runtimeBytes.endsWith("\n")).toBe(true);
      expect(clermontBaselineSha256(fixture)).toBe(sha256Text(runtimeBytes));
      expect(clermontBaselineSha256(fixture)).not.toBe(sha256Text(runtimeBytes.trimEnd()));
    }
  });

  it("preserves identity for reordered input keys but changes it on content tamper", () => {
    const original = { Z: null, a: [{ b: 2, A: "captured" }] };
    const reordered = { a: [{ A: "captured", b: 2 }], Z: null };
    const tampered = { a: [{ A: "changed", b: 2 }], Z: null };
    expect(clermontBaselineSha256(reordered)).toBe(clermontBaselineSha256(original));
    expect(clermontBaselineSha256(tampered)).not.toBe(clermontBaselineSha256(original));
  });
});
