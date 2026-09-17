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
    expect(script).toContain('message.type() !== "error"');
    expect(script).toContain("Agent returned citations but no actual answer text");
    expect(script).toContain('name: "Roof at least 15 years old"');
    expect(script).toContain("radiusResult.provenance?.rootCid !== rootCid");
    expect(script).toContain('name: "Run query"');
    expect(script).toContain("Public manifest bytes differ from the chosen immutable packet");
    expect(script).toContain("externalGatewayErrors.push(observed)");
    expect(script).toContain("observed.location.url === `${gateway}/favicon.ico`");
    expect(script).toContain("else failures.push(observed)");
    expect(script).toContain('complete ? "preview-demo.json" : "failed-preview-demo.json"');
    expect(script).toContain("Agent sample differs from exact hosted query rows");
    expect(script).toContain("Property answer has no canonical query-row grounding");
    expect(script).toContain('chat.grounding?.mode !== "source-only-refusal"');
    expect(script).toContain("observation.groundingVerified = true");
    expect(script).toContain("functionalQuestionFulfilled: false");
    expect(script).toContain('observation.answerOutcome = "no-verified-records"');
    expect(script).toContain("Agent abstention contradicts its selected-run evidence");
  });
  it("does not change the strict full-demo release contract", async () => {
    const script = await readFile("packages/ui/scripts/record-demo.mjs", "utf8");
    expect(script).toContain("assertDemoContract({");
    expect(script).toContain("queryArtifact.sha256 === priorQueryArtifact.sha256");
    expect(script).toContain("await verifyManifestAcrossGateways");
    expect(script).not.toContain("record-preview");
  });
});
