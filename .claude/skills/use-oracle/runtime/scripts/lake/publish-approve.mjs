#!/usr/bin/env node
/**
 * The human half of the publish gate.
 *
 * Bulk property data reaching public IPFS is human-gated: the agent prepares
 * and verifies everything up to this point, and only a human approves. This is
 * the local equivalent of the kit's `Publish/<county>/approve` handler — the
 * durable decision that lets `publish-run.mjs` upload instead of dry-running.
 *
 * The approval names who gave it and what they were told they were approving,
 * because an approval with neither is not evidence of anything. It is written
 * to `artifacts/publish-gate.json`, which is committed, so the decision
 * survives a runner and stays reviewable in the same history as the data.
 *
 * Usage:
 *   node scripts/lake/publish-approve.mjs --county lake --by "Name" --note "..."
 *   node scripts/lake/publish-approve.mjs --county lake --by "Name" --note "..." \
 *     --recorded-by "agent, on the owner's authority"
 *   node scripts/lake/publish-approve.mjs --county lake --revoke
 *   node scripts/lake/publish-approve.mjs --county lake --status
 *
 * @module scripts/lake/publish-approve
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  approvePublish,
  readCountyGate,
  revokePublishApproval,
} from "../../src/core/publish-gate.mjs";

const RUNTIME_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_ROOT = path.resolve(RUNTIME_ROOT, "..", "..", "..", "..");
const GATE_PATH = path.join(REPO_ROOT, "artifacts", "publish-gate.json");

/**
 * @param {readonly string[]} argv - CLI arguments.
 * @returns {Record<string, string | boolean>} Parsed flags.
 */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) flags[token.slice(2)] = true;
    else {
      flags[token.slice(2)] = next;
      index += 1;
    }
  }
  return flags;
}

const flags = parseArgs(process.argv.slice(2));
const county = typeof flags.county === "string" ? flags.county : "lake";

/**
 * @returns {Promise<void>}
 */
async function main() {
  if (flags.status === true) {
    process.stdout.write(`${JSON.stringify(await readCountyGate(GATE_PATH, county), null, 2)}\n`);
    return;
  }
  if (flags.revoke === true) {
    const state = await revokePublishApproval(GATE_PATH, county);
    process.stdout.write(
      `${JSON.stringify({ event: "publish_approval_revoked", county, ...state })}\n`,
    );
    return;
  }
  if (typeof flags.by !== "string" || typeof flags.note !== "string") {
    process.stderr.write(
      'usage: publish-approve.mjs --county <key> --by "<human>" --note "<what was approved>"\n' +
        '       [--recorded-by "<who wrote the record, if not the approver>"]\n' +
        "       publish-approve.mjs --county <key> --revoke\n" +
        "       publish-approve.mjs --county <key> --status\n",
    );
    process.exit(2);
    return;
  }
  const state = await approvePublish(GATE_PATH, county, {
    approvedBy: flags.by,
    note: flags.note,
    recordedBy: typeof flags["recorded-by"] === "string" ? flags["recorded-by"] : undefined,
  });
  process.stdout.write(`${JSON.stringify({ event: "publish_approved", county, ...state })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
