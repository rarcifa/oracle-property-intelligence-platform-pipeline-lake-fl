import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("partial preview recorder, not a full acceptance demo", () => {
  it("checks the explicit hosted identity before any browser launch", async () => {
    const script = await readFile("packages/ui/scripts/record-preview.mjs", "utf8");
    expect(script).toContain('new URL(base).protocol !== "https:"');
    expect(script.indexOf('get("/api/meta/run")')).toBeLessThan(
      script.indexOf("await chromium.launch"),
    );
    expect(script).toContain("meta.coverage?.runId !== runId");
    expect(script).toContain("health.rootCid !== rootCid");
    expect(script).toContain("meta.countyComplete !== false");
    expect(script).toContain("meta.sourceObservationsOnly !== true");
  });
  it("labels the captured walkthrough honestly and rejects runtime failures", async () => {
    const script = await readFile("packages/ui/scripts/record-preview.mjs", "utf8");
    expect(script).toContain("fullAssignmentDemoPassed: false");
    expect(script).toContain("independentRetentionVerified: false");
    expect(script).toContain("publicationPromoted: false");
    expect(script).toContain("Hosted preview became blank");
    expect(script).toContain("Preview runtime failures");
    expect(script).toContain('page.on("pageerror"');
    expect(script).toContain('message.type() === "error"');
  });
  it("does not change the strict full-demo release contract", async () => {
    const script = await readFile("packages/ui/scripts/record-demo.mjs", "utf8");
    expect(script).toContain("assertDemoContract({");
    expect(script).toContain("queryArtifact.sha256 === priorQueryArtifact.sha256");
    expect(script).toContain("await verifyManifestAcrossGateways");
    expect(script).not.toContain("record-preview");
  });
});
