#!/usr/bin/env node
/**
 * Human signing utility for one exact Lake publication target.
 *
 * Naming an approver on a CLI is not authority. This command only produces an
 * authorization when the caller possesses an external Ed25519 private key,
 * and it refuses to write the key or signed approval inside the repository.
 *
 * @module scripts/lake/publish-approve
 */

import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildPublishAuthorizationPayload,
  nextPublicationRecoveryAction,
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
    "usage: publish-approve.mjs --request <publication-request.json> " +
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
  const required = ["request", "private-key", "output", "approver", "expires-at"];
  if (required.some((name) => typeof flags[name] !== "string")) {
    throw new Error(usage().trim());
  }
  const privateKeyPath = assertExternalPath(flags["private-key"]);
  const outputPath = assertExternalPath(flags.output);
  const request = JSON.parse(await readFile(flags.request, "utf8"));
  if (request.schemaVersion !== "elephant.publication-request.v1") {
    throw new Error("publication request has an unsupported schemaVersion");
  }
  const target = validatePublicationTarget(request.target);
  const payload = buildPublishAuthorizationPayload(target, {
    issuedAt:
      typeof flags["issued-at"] === "string" ? flags["issued-at"] : new Date().toISOString(),
    expiresAt: flags["expires-at"],
    nonce: typeof flags.nonce === "string" ? flags.nonce : randomBytes(24).toString("base64url"),
    approver: flags.approver,
  });
  const authorization = signPublishAuthorization(payload, await readFile(privateKeyPath));
  await writeFile(outputPath, `${JSON.stringify(authorization, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return {
    event: "publication_authorization_signed",
    attemptId: request.attemptId,
    target,
    expiresAt: payload.expiresAt,
    nonce: payload.nonce,
    keyId: authorization.signature.keyId,
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
