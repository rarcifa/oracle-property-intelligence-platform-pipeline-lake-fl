#!/usr/bin/env node
/**
 * Record human approval for one exact Lake replication target.
 *
 * This utility records actual owner consent, not agent-generated consent.
 * --record-approval requires explicit human approval already supplied by the
 * owner. No private key or personal signing step is needed for replication.
 * Optional legacy signing remains available; all evidence stays external.
 *
 * @module scripts/lake/publish-approve
 */

import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildPublishAuthorizationPayload,
  buildHumanPublishApproval,
  nextPublicationRecoveryAction,
  publicationAttemptId,
  readPublicationLedger,
  signPublishAuthorization,
  validatePublicationTarget,
} from "../../src/core/publish-gate.mjs";

const RUNTIME_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_ROOT = path.resolve(RUNTIME_ROOT, "..");
const LEDGER_PATH = path.join(REPO_ROOT, "artifacts", "publication-attempts.json");

/** @param {readonly string[]} argv */
export function parseApprovalArgs(argv) {
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

/** @param {string} candidate */
function assertExternalPath(candidate) {
  const resolved = path.resolve(candidate);
  if (resolved === REPO_ROOT || resolved.startsWith(`${REPO_ROOT}${path.sep}`)) {
    throw new Error(
      "private signing material and signed approvals must stay outside the repository",
    );
  }
  return resolved;
}

function usage() {
  return (
    "usage: publish-approve.mjs --record-approval --request <publication-request.json> " +
    "--output <external-approval.json> --approver <identity> " +
    "--approval-source owner-conversation --expires-at <ISO-8601>\n" +
    "       legacy signing: publish-approve.mjs --request <publication-request.json> " +
    "--private-key <external-ed25519.pem> --output <external-approval.json> " +
    "--approver <identity> --expires-at <ISO-8601> [--issued-at <ISO-8601>] " +
    "[--nonce <unguessable-value>]\n" +
    "       publish-approve.mjs --status [--attempt-id <sha256:...>]\n"
  );
}

/** @param {Record<string, string | boolean>} flags */
export async function runApprovalCommand(flags) {
  if (flags.status === true) {
    const ledger = await readPublicationLedger(LEDGER_PATH);
    if (typeof flags["attempt-id"] !== "string") return ledger;
    const attempt = ledger.attempts[flags["attempt-id"]];
    if (!attempt) throw new Error(`Unknown publication attempt ${flags["attempt-id"]}`);
    return { ...attempt, nextAction: nextPublicationRecoveryAction(attempt) };
  }
  const recording = flags["record-approval"] === true;
  const required = ["request", "output", "approver", "expires-at"];
  if (!recording) required.push("private-key");
  else required.push("approval-source");
  if (required.some((name) => typeof flags[name] !== "string")) {
    throw new Error(usage().trim());
  }
  if (recording && flags["private-key"] !== undefined)
    throw new Error("Choose recorded human approval or legacy signing, not both");
  const outputPath = assertExternalPath(flags.output);
  const request = JSON.parse(await readFile(flags.request, "utf8"));
  if (request.schemaVersion !== "elephant.publication-request.v1") {
    throw new Error("publication request has an unsupported schemaVersion");
  }
  const target = validatePublicationTarget(request.target);
  if (request.attemptId !== publicationAttemptId(target))
    throw new Error("publication request attemptId does not match its exact target");
  const details = {
    issuedAt:
      typeof flags["issued-at"] === "string" ? flags["issued-at"] : new Date().toISOString(),
    expiresAt: flags["expires-at"],
    nonce: typeof flags.nonce === "string" ? flags.nonce : randomBytes(24).toString("base64url"),
    approver: flags.approver,
  };
  const authorization = recording
    ? buildHumanPublishApproval(target, {
        approvedBy: details.approver,
        approvedAt: details.issuedAt,
        expiresAt: details.expiresAt,
        nonce: details.nonce,
        approvalSource: flags["approval-source"],
      })
    : signPublishAuthorization(
        buildPublishAuthorizationPayload(target, details),
        await readFile(assertExternalPath(flags["private-key"])),
      );
  await writeFile(outputPath, `${JSON.stringify(authorization, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  return {
    event: recording ? "publication_human_approval_recorded" : "publication_authorization_signed",
    attemptId: request.attemptId,
    target,
    expiresAt: details.expiresAt,
    nonce: details.nonce,
    ...(recording
      ? { approvalSource: authorization.approvalSource, cryptographicallyAuthenticated: false }
      : { keyId: authorization.signature.keyId }),
    outputPath,
  };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  runApprovalCommand(parseApprovalArgs(process.argv.slice(2)))
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
