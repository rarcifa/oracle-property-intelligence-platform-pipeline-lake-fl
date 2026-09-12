/**
 * Release identity and coverage assertions for the recorded public demo.
 *
 * Keep these checks independent of Playwright so CI can prove that a recording
 * will refuse a stale deployment before a browser or video file is created.
 */

export const EXPECTED_MCP_TOOLS = Object.freeze([
  "findAgedRoofs",
  "findOpenRoofPermits",
  "findPropertiesInRadius",
  "getOracleDatasetInfo",
  "getOracleProperty",
  "getPropertyPermits",
  "getPropertyQuerySchema",
  "listOracleProperties",
  "queryProperties",
]);

const EXPECTED_CLERMONT_YEARS = Object.freeze(
  Array.from({ length: 12 }, (_, index) => String(index + 15).padStart(2, "0")),
);

function fail(message) {
  throw new Error(`demo contract failed: ${message}`);
}

function assertIdentity(value, expectedRunId, expectedRootCid, label) {
  if (value?.runId !== expectedRunId || value?.rootCid !== expectedRootCid) {
    fail(`${label} does not identify ${expectedRunId}/${expectedRootCid}`);
  }
}

function requiredCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a non-negative integer`);
  return value;
}

/**
 * Assert that all public surfaces describe the exact finalized release the
 * operator intended to record.
 *
 * @param {{
 *   meta: any,
 *   tools: any,
 *   contractor: any,
 *   business: any,
 *   expectedRunId: string,
 *   expectedRootCid: string,
 * }} input
 */
export function assertDemoContract({
  meta,
  tools,
  contractor,
  business,
  expectedRunId,
  expectedRootCid,
}) {
  if (!/^\d{8}T\d{6}Z$/.test(expectedRunId)) fail("DEMO_RUN_ID is not a run ID");
  if (!/^b[a-z2-7]{20,}$/.test(expectedRootCid)) fail("DEMO_ROOT_CID is not a CID");

  assertIdentity(meta?.run, expectedRunId, expectedRootCid, "/api/meta/run");
  assertIdentity(
    contractor?.provenance,
    expectedRunId,
    expectedRootCid,
    "/api/views/contractor provenance",
  );
  assertIdentity(
    business?.provenance,
    expectedRunId,
    expectedRootCid,
    "/api/views/business provenance",
  );

  const toolNames = tools?.result?.tools?.map((tool) => tool?.name).sort();
  if (JSON.stringify(toolNames) !== JSON.stringify([...EXPECTED_MCP_TOOLS].sort())) {
    fail(`MCP must expose exactly nine expected tools; received ${JSON.stringify(toolNames)}`);
  }

  const coverage = meta?.coverage?.tables?.contractors;
  if (
    coverage?.availability !== "supported_partial" ||
    coverage?.jurisdictionsCovered !== 1 ||
    coverage?.jurisdictionsInCounty !== 15 ||
    coverage?.complete !== true
  ) {
    fail("contractor coverage must be complete for Clermont and explicitly partial countywide");
  }
  if (JSON.stringify(coverage.permitYears) !== JSON.stringify(EXPECTED_CLERMONT_YEARS)) {
    fail("Clermont contractor evidence must cover the exact 2015-2026 permit history");
  }

  if (!(contractor?.posture?.contractor_names_present > 0)) {
    fail("the finalized Clermont harvest must publish at least one contractor name");
  }
  if (contractor?.posture?.bbb_ratings_present !== 0) {
    fail("BBB ratings must remain honestly absent");
  }
  const contractorNote = contractor?.note ?? "";
  if (
    !/Clermont/i.test(contractorNote) ||
    !/(one|1)[^.!]{0,80}(fifteen|15)|(only)[^.!]{0,80}(jurisdiction|municipality)/i.test(
      contractorNote,
    )
  ) {
    fail("contractor view must state that contractor coverage is Clermont-only");
  }
  const bbbNotice = contractor?.gating?.find((notice) => notice?.field === "bbb_rating");
  if (!bbbNotice || !/403/.test(bbbNotice.detail ?? "") || !/policy|API/i.test(bbbNotice.detail)) {
    fail("contractor view must preserve the BBB policy/API gate and default-route HTTP 403");
  }

  const businessCoverage = meta?.coverage?.tables?.businessAccounts;
  const sourceAccounts = requiredCount(businessCoverage?.rows, "business source accounts");
  const withSitusAddress = requiredCount(
    businessCoverage?.withSitusAddress,
    "business accounts with situs address",
  );
  const matchedToParcel = requiredCount(
    businessCoverage?.matchedToParcel,
    "business accounts matched to a parcel",
  );
  const attributedAcrossParcels = requiredCount(
    businessCoverage?.attributedAcrossParcels,
    "business account-to-parcel matches",
  );
  const propertiesWithAccount = requiredCount(
    businessCoverage?.propertiesWithAccount,
    "properties with a business account",
  );
  const sharedAddressGroups = requiredCount(
    businessCoverage?.sharedAddressGroups,
    "shared-address groups",
  );
  if (
    sourceAccounts === 0 ||
    withSitusAddress > sourceAccounts ||
    matchedToParcel > withSitusAddress ||
    attributedAcrossParcels < matchedToParcel ||
    propertiesWithAccount === 0
  ) {
    fail("business coverage counts are internally inconsistent");
  }
  if (
    business?.totals?.business_accounts !== attributedAcrossParcels ||
    business?.totals?.properties_with_accounts !== propertiesWithAccount
  ) {
    fail("business view totals do not match this release's coverage snapshot");
  }

  return {
    runId: expectedRunId,
    rootCid: expectedRootCid,
    toolCount: toolNames.length,
    contractorNames: contractor.posture.contractor_names_present,
    contractorJurisdictions: "1/15",
    contractorPermitYears: [...EXPECTED_CLERMONT_YEARS],
    bbbRatings: 0,
    business: {
      sourceAccounts,
      withSitusAddress,
      matchedToParcel,
      attributedAcrossParcels,
      propertiesWithAccount,
      sharedAddressGroups,
    },
  };
}
