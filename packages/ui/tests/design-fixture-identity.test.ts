import { describe, expect, it } from "vitest";

import { DESIGN_FIXTURE_IDENTITY, FIXTURES } from "../test/design/support/harness.js";

function record(value: unknown): Record<string, unknown> {
  expect(value).not.toBeNull();
  expect(typeof value).toBe("object");
  return value as Record<string, unknown>;
}

describe("design fixture identity", () => {
  it("marks the combined design lane synthetic and never lends it a public release identity", () => {
    expect(record(FIXTURES.run.run)).toMatchObject(DESIGN_FIXTURE_IDENTITY);
    expect(FIXTURES.run.dataSource).toBe(DESIGN_FIXTURE_IDENTITY.dataSource);

    for (const name of [
      "stats",
      "tenant",
      "business",
      "contractor",
      "search",
      "property",
    ] as const) {
      expect(record(FIXTURES[name].provenance), name).toMatchObject(DESIGN_FIXTURE_IDENTITY);
    }
  });
});
