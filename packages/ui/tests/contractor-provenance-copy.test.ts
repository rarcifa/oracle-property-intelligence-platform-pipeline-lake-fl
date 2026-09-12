import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("contractor evidence provenance", () => {
  it("attributes browser aggregates to both permit sources", async () => {
    const source = await readFile(path.resolve("packages/ui/src/data/duckdbSource.ts"), "utf8");
    const contractorView = source.slice(source.indexOf("async getContractorView"));
    expect(contractorView).toContain(
      'provenance(sql, ["lake_cdplus_permits", "lake_clermont_etrakit_permits"])',
    );
  });

  it("labels permit posture as combined Lake CD Plus and Clermont eTRAKiT evidence", async () => {
    const source = await readFile(path.resolve("packages/ui/src/views/ContractorView.tsx"), "utf8");
    expect(source).toContain(
      'subtitle="Aggregated from the Lake County CD Plus permit layer and Clermont eTRAKiT evidence."',
    );
    expect(source).not.toContain(
      'subtitle="Aggregated from the Lake County CD Plus permit layer."',
    );
  });
});
