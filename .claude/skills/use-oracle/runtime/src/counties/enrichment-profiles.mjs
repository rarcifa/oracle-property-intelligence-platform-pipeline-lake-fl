import { createEnrichmentProfileRegistry } from "./enrichment-profile.mjs";
import { duvalEnrichmentProfile } from "./duval/enrichment-profile.mjs";
import { lakeEnrichmentProfile } from "./lake/enrichment-profile.mjs";

export const enrichmentProfileRegistry = createEnrichmentProfileRegistry([
  duvalEnrichmentProfile,
  lakeEnrichmentProfile,
]);

export function requireEnrichmentProfile(countyKey) {
  return enrichmentProfileRegistry.require(countyKey);
}
