import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = path.resolve("packages/ui/scripts/record-demo.mjs");

describe("record-demo release safety", () => {
  it("requires an explicit release and performs the API contract before launching", async () => {
    const source = await readFile(scriptPath, "utf8");
    expect(source).toContain("DEMO_BASE_URL");
    expect(source).toContain("DEMO_RUN_ID");
    expect(source).toContain("DEMO_ROOT_CID");
    expect(source.indexOf("assertDemoContract({")).toBeLessThan(
      source.indexOf("await chromium.launch"),
    );
    expect(source).not.toMatch(/DEMO_ROOT_CID\s*\?\?/);
  });

  it("does not swallow a failed recording beat", async () => {
    const source = await readFile(scriptPath, "utf8");
    expect(source).not.toContain('console.error("beat failed:"');
    expect(source).toContain("throw new Error(`demo beat never became ready:");
    expect(source).toContain("if (!coverageResponse?.ok())");
    expect(source).toContain("if (completed) console.log");
  });

  it("describes partial contractor evidence instead of claiming the data is absent", async () => {
    const source = await readFile(scriptPath, "utf8");
    expect(source).not.toContain("the data does not contain");
    expect(source).toContain("contractor names may exist for Clermont permits");
    expect(source).toContain("other jurisdictions and BBB remain gated");
  });

  it("derives business figures from the selected release before recording", async () => {
    const source = await readFile(scriptPath, "utf8");
    expect(source.indexOf('responseJson("/api/views/business")')).toBeLessThan(
      source.indexOf("await chromium.launch"),
    );
    expect(source).toContain("release.business.sourceAccounts.toLocaleString()");
    expect(source).toContain("release.business.attributedAcrossParcels.toLocaleString()");
    expect(source).not.toMatch(/33,346|32,738|2,060|4,451|2,726/);
  });
});
