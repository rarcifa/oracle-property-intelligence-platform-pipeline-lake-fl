/**
 * Exact-target publication authorization and durable attempt ledger.
 *
 * A name and a boolean are not publication authority. A live release requires
 * an Ed25519 signature over the immutable artifact and its exact destination.
 * The private key and signed approval are intentionally kept outside this
 * repository. The ledger records effects after they happen and makes retries
 * resume the same attempt rather than starting a second writer.
 *
 * @module core/publish-gate
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
  verify as verifyBytes,
} from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { canonicalJson } from "./coverage-publication.mjs";

export const PUBLISH_AUTHORIZATION_SCHEMA_VERSION = "elephant.publish-authorization.v2";
export const PUBLICATION_LEDGER_SCHEMA_VERSION = "elephant.publication-attempt-ledger.v1";

export const REQUIRED_PUBLISH_ACTIONS = Object.freeze([
  "upload-root-car",
  "upload-manifest-car",
  "pin-secondary-copy",
  "verify-all-artifacts-two-gateways",
  "append-history",
  "repoint-ipns",
]);

export const PUBLICATION_STAGES = Object.freeze([
  "PREPARED",
  "FROZEN",
  "BUILT",
  "AUTHORIZED",
  "ROOT_UPLOAD_RECORDED",
  "MANIFEST_UPLOAD_RECORDED",
  "SECONDARY_PIN_RECORDED",
  "VERIFIED",
  "HISTORY_RECORDED",
  "IPNS_REPOINT_RECORDED",
  "IPNS_VERIFIED",
  "APPROVAL_CONSUMED",
  "FINALIZED",
]);

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const COUNTY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const WORKFLOW_RUN_ID_PATTERN = /^(?:local|[1-9][0-9]{0,19})$/;
const CID_PATTERN = /^b[a-z2-7]{20,}$/;
const IPNS_PATTERN = /^k[a-z0-9]{20,}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

const isoTimestamp = z.string().datetime({ offset: true });
const digest = z.string().regex(SHA256_PATTERN);
const jsonValue = z.unknown();

const LEGACY_PUBLISH_ACTIONS = Object.freeze([
  "upload-root-car",
  "upload-manifest-car",
  "verify-all-artifacts-two-gateways",
  "append-history",
  "repoint-ipns",
]);

export const publicationTargetSchema = z
  .object({
    county: z.string().regex(COUNTY_PATTERN),
    runId: z.string().regex(RUN_ID_PATTERN),
    mode: z.enum(["full", "incremental"]),
    candidateWorkflowRunId: z.string().regex(WORKFLOW_RUN_ID_PATTERN),
    rootCid: z.string().regex(CID_PATTERN),
    manifestDigest: digest,
    provenanceDigest: digest,
    bucket: z.string().trim().min(1),
    ipnsLabel: z.string().trim().min(1),
    ipnsNetworkKey: z.string().regex(IPNS_PATTERN),
    actions: z.array(z.enum(REQUIRED_PUBLISH_ACTIONS)).length(REQUIRED_PUBLISH_ACTIONS.length),
  })
  .strict()
  .superRefine((target, context) => {
    if (canonicalJson(target.actions) !== canonicalJson(REQUIRED_PUBLISH_ACTIONS)) {
      context.addIssue({
        code: "custom",
        path: ["actions"],
        message: "must equal the required ordered publication actions",
      });
    }
    if (target.ipnsLabel !== `oracle-open-data-${target.county}`) {
      context.addIssue({
        code: "custom",
        path: ["ipnsLabel"],
        message: "must be derived from county",
      });
    }
  });

// Attempts prepared before mode and workflow identity were added to the signed
// target remain readable so their append-only evidence is not destroyed. They
// can never receive authorization; a new candidate must be prepared with the
// current schema first.
const preIdentityPublicationTargetSchema = z
  .object({
    county: z.string().regex(COUNTY_PATTERN),
    runId: z.string().regex(RUN_ID_PATTERN),
    rootCid: z.string().regex(CID_PATTERN),
    manifestDigest: digest,
    provenanceDigest: digest,
    bucket: z.string().trim().min(1),
    ipnsLabel: z.string().trim().min(1),
    ipnsNetworkKey: z.string().regex(IPNS_PATTERN),
    actions: z.array(z.enum(REQUIRED_PUBLISH_ACTIONS)).length(REQUIRED_PUBLISH_ACTIONS.length),
  })
  .strict()
  .superRefine((target, context) => {
    if (canonicalJson(target.actions) !== canonicalJson(REQUIRED_PUBLISH_ACTIONS)) {
      context.addIssue({
        code: "custom",
        path: ["actions"],
        message: "invalid pre-identity actions",
      });
    }
    if (target.ipnsLabel !== `oracle-open-data-${target.county}`) {
      context.addIssue({
        code: "custom",
        path: ["ipnsLabel"],
        message: "must be derived from county",
      });
    }
  });

// Local-only attempts created before independent replication became mandatory
// stay readable as immutable evidence, but only after they have been rolled
// back. New or active attempts must use publicationTargetSchema above.
const legacyPublicationTargetSchema = z
  .object({
    county: z.string().regex(COUNTY_PATTERN),
    runId: z.string().regex(RUN_ID_PATTERN),
    rootCid: z.string().regex(CID_PATTERN),
    manifestDigest: digest,
    provenanceDigest: digest,
    bucket: z.string().trim().min(1),
    ipnsLabel: z.string().trim().min(1),
    ipnsNetworkKey: z.string().regex(IPNS_PATTERN),
    actions: z.array(z.enum(LEGACY_PUBLISH_ACTIONS)).length(LEGACY_PUBLISH_ACTIONS.length),
  })
  .strict()
  .superRefine((target, context) => {
    if (canonicalJson(target.actions) !== canonicalJson(LEGACY_PUBLISH_ACTIONS)) {
      context.addIssue({ code: "custom", path: ["actions"], message: "invalid legacy actions" });
    }
    if (target.ipnsLabel !== `oracle-open-data-${target.county}`) {
      context.addIssue({
        code: "custom",
        path: ["ipnsLabel"],
        message: "must be derived from county",
      });
    }
  });

export const publishAuthorizationPayloadSchema = z
  .object({
    schemaVersion: z.literal(PUBLISH_AUTHORIZATION_SCHEMA_VERSION),
    kind: z.literal("oracle-open-data-publication"),
    target: z.union([
      publicationTargetSchema,
      preIdentityPublicationTargetSchema,
      legacyPublicationTargetSchema,
    ]),
    issuedAt: isoTimestamp,
    expiresAt: isoTimestamp,
    nonce: z.string().regex(NONCE_PATTERN),
    approver: z.string().trim().min(1),
  })
  .strict()
  .refine(
    (payload) => Date.parse(payload.expiresAt) > Date.parse(payload.issuedAt),
    "expiresAt must be after issuedAt",
  );

export const publishAuthorizationSchema = z
  .object({
    payload: publishAuthorizationPayloadSchema,
    signature: z
      .object({
        algorithm: z.literal("ed25519"),
        keyId: digest,
        value: z.string().min(1),
      })
      .strict(),
  })
  .strict();

const transitionSchema = z
  .object({
    sequence: z.number().int().positive(),
    stage: z.enum([...PUBLICATION_STAGES, "ROLLED_BACK"]),
    at: isoTimestamp,
    receipt: jsonValue,
  })
  .strict();

const attemptSchema = z
  .object({
    attemptId: digest,
    target: z.union([
      publicationTargetSchema,
      preIdentityPublicationTargetSchema,
      legacyPublicationTargetSchema,
    ]),
    state: z.enum([...PUBLICATION_STAGES, "ROLLED_BACK"]),
    createdAt: isoTimestamp,
    updatedAt: isoTimestamp,
    authorization: z
      .object({
        nonce: z.string(),
        approvalDigest: digest,
        keyId: digest,
        issuedAt: isoTimestamp,
        expiresAt: isoTimestamp,
        approver: z.string().trim().min(1),
      })
      .strict()
      .nullable(),
    transitions: z.array(transitionSchema).min(1),
  })
  .strict();

const historicalAttemptSchema = z
  .object({
    attemptId: z.string().min(1),
    county: z.string().regex(COUNTY_PATTERN),
    runId: z.string().regex(RUN_ID_PATTERN),
    rootCid: z.string().regex(CID_PATTERN),
    manifestCid: z.string().regex(CID_PATTERN),
    disposition: z.literal("ROLLED_BACK"),
    recordedAt: isoTimestamp,
    reason: z.string().trim().min(1),
    evidence: z.array(z.string().trim().min(1)).min(1),
  })
  .strict();

export const publicationLedgerSchema = z
  .object({
    schemaVersion: z.literal(PUBLICATION_LEDGER_SCHEMA_VERSION),
    revision: z.number().int().nonnegative(),
    attempts: z.record(z.string(), attemptSchema),
    consumedApprovals: z.array(
      z
        .object({
          nonce: z.string(),
          attemptId: digest,
          consumedAt: isoTimestamp,
        })
        .strict(),
    ),
    historicalAttempts: z.array(historicalAttemptSchema),
  })
  .strict();

/** @param {Buffer | string} bytes @returns {string} */
export function sha256Digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** @param {unknown} value @returns {string} */
function digestJson(value) {
  return sha256Digest(Buffer.from(canonicalJson(value), "utf8"));
}

/** @param {unknown} value @returns {import("zod").infer<typeof publicationTargetSchema>} */
export function validatePublicationTarget(value) {
  const result = publicationTargetSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `Invalid publication target: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    );
  }
  return result.data;
}

/** @param {unknown} value @returns {import("zod").infer<typeof publicationLedgerSchema>} */
export function validatePublicationLedger(value) {
  const result = publicationLedgerSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `Invalid publication ledger: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    );
  }
  for (const [attemptId, attempt] of Object.entries(result.data.attempts)) {
    if (attemptId !== attempt.attemptId || attemptId !== digestJson(attempt.target)) {
      throw new Error(
        `Invalid publication ledger: attempt key ${attemptId} does not match its exact target`,
      );
    }
    if (attempt.transitions.at(-1)?.stage !== attempt.state) {
      throw new Error(
        `Invalid publication ledger: ${attemptId} state does not match its last transition`,
      );
    }
    attempt.transitions.forEach((transition, index) => {
      if (transition.sequence !== index + 1) {
        throw new Error(
          `Invalid publication ledger: ${attemptId} transition sequence is not contiguous`,
        );
      }
    });
    const stages = attempt.transitions.map((transition) => transition.stage);
    const rolledBack = stages.at(-1) === "ROLLED_BACK";
    const legacyTarget =
      canonicalJson(attempt.target.actions) === canonicalJson(LEGACY_PUBLISH_ACTIONS);
    if (legacyTarget && !rolledBack) {
      throw new Error("Invalid publication ledger: a legacy target must be rolled back");
    }
    const activeStages = rolledBack ? stages.slice(0, -1) : stages;
    const expectedStages = PUBLICATION_STAGES.slice(0, activeStages.length);
    if (canonicalJson(activeStages) !== canonicalJson(expectedStages)) {
      throw new Error(
        `Invalid publication ledger: ${attemptId} transitions are not a stage prefix`,
      );
    }
    if (rolledBack && activeStages.includes("AUTHORIZED")) {
      throw new Error(`Invalid publication ledger: ${attemptId} rolls back an authorized attempt`);
    }
    const reachedAuthorization = activeStages.includes("AUTHORIZED");
    if (reachedAuthorization !== (attempt.authorization !== null)) {
      throw new Error(
        `Invalid publication ledger: ${attemptId} authorization receipt is inconsistent`,
      );
    }
  }
  const nonces = result.data.consumedApprovals.map((approval) => approval.nonce);
  if (new Set(nonces).size !== nonces.length) {
    throw new Error("Invalid publication ledger: approval nonces must be consumed at most once");
  }
  return result.data;
}

/** @param {string} ledgerPath */
export async function readPublicationLedger(ledgerPath) {
  try {
    return validatePublicationLedger(JSON.parse(await readFile(ledgerPath, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        schemaVersion: PUBLICATION_LEDGER_SCHEMA_VERSION,
        revision: 0,
        attempts: {},
        consumedApprovals: [],
        historicalAttempts: [],
      };
    }
    throw error;
  }
}

/** @param {string} ledgerPath @param {unknown} value */
async function writeLedger(ledgerPath, value) {
  const ledger = validatePublicationLedger(value);
  const body = `${JSON.stringify(ledger, null, 2)}\n`;
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  const temporaryPath = `${ledgerPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, body, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, ledgerPath);
  return ledger;
}

/** @param {unknown} target @returns {string} */
export function publicationAttemptId(target) {
  return digestJson(validatePublicationTarget(target));
}

/**
 * @param {unknown} target
 * @param {{ issuedAt: string, expiresAt: string, nonce: string, approver: string }} approval
 */
export function buildPublishAuthorizationPayload(target, approval) {
  return publishAuthorizationPayloadSchema.parse({
    schemaVersion: PUBLISH_AUTHORIZATION_SCHEMA_VERSION,
    kind: "oracle-open-data-publication",
    target: validatePublicationTarget(target),
    ...approval,
  });
}

/** @param {import("node:crypto").KeyObject | string | Buffer} key */
function publicKeyId(key) {
  const publicKey =
    typeof key === "object" && key !== null && "type" in key && key.type === "public"
      ? key
      : createPublicKey(key);
  return sha256Digest(publicKey.export({ type: "spki", format: "der" }));
}

/** @param {unknown} payload @param {string | Buffer} privateKeyPem */
export function signPublishAuthorization(payload, privateKeyPem) {
  const validated = publishAuthorizationPayloadSchema.parse(payload);
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("publication authorization private key must be Ed25519");
  }
  const publicKey = createPublicKey(privateKey);
  return {
    payload: validated,
    signature: {
      algorithm: "ed25519",
      keyId: publicKeyId(publicKey),
      value: signBytes(null, Buffer.from(canonicalJson(validated), "utf8"), privateKey).toString(
        "base64",
      ),
    },
  };
}

/**
 * @param {unknown} authorization
 * @param {string | Buffer} publicKeyPem
 * @param {unknown} expectedTarget
 * @param {{ now?: string }} [options]
 */
export function verifyPublishAuthorization(
  authorization,
  publicKeyPem,
  expectedTarget,
  { now = new Date().toISOString() } = {},
) {
  const validated = publishAuthorizationSchema.parse(authorization);
  const target = validatePublicationTarget(expectedTarget);
  if (canonicalJson(validated.payload.target) !== canonicalJson(target)) {
    throw new Error("publication authorization does not match the exact target");
  }
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error("authorization verification time is invalid");
  if (nowMs < Date.parse(validated.payload.issuedAt)) {
    throw new Error("publication authorization is not active yet");
  }
  if (nowMs >= Date.parse(validated.payload.expiresAt)) {
    throw new Error("publication authorization has expired");
  }
  const publicKey = createPublicKey(publicKeyPem);
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("publication authorization public key must be Ed25519");
  }
  if (validated.signature.keyId !== publicKeyId(publicKey)) {
    throw new Error("publication authorization keyId does not match the trusted public key");
  }
  const signature = Buffer.from(validated.signature.value, "base64");
  if (
    signature.length !== 64 ||
    !verifyBytes(null, Buffer.from(canonicalJson(validated.payload), "utf8"), publicKey, signature)
  ) {
    throw new Error("publication authorization signature verification failed");
  }
  return validated;
}

/** @param {string} ledgerPath @param {unknown} target @param {{ at?: string }} [options] */
export async function beginPublicationAttempt(
  ledgerPath,
  target,
  { at = new Date().toISOString() } = {},
) {
  const validatedTarget = validatePublicationTarget(target);
  const attemptId = publicationAttemptId(validatedTarget);
  const ledger = await readPublicationLedger(ledgerPath);
  if (ledger.attempts[attemptId]) return ledger.attempts[attemptId];
  const attempt = {
    attemptId,
    target: validatedTarget,
    state: "PREPARED",
    createdAt: at,
    updatedAt: at,
    authorization: null,
    transitions: [{ sequence: 1, stage: "PREPARED", at, receipt: { localOnly: true } }],
  };
  await writeLedger(ledgerPath, {
    ...ledger,
    revision: ledger.revision + 1,
    attempts: { ...ledger.attempts, [attemptId]: attempt },
  });
  return attempt;
}

/**
 * Record one completed transition. Repeating the identical transition is
 * idempotent; skipping or changing an already-recorded receipt fails closed.
 *
 * @param {string} ledgerPath
 * @param {string} attemptId
 * @param {typeof PUBLICATION_STAGES[number]} stage
 * @param {unknown} receipt
 * @param {{ at?: string }} [options]
 */
export async function advancePublicationAttempt(
  ledgerPath,
  attemptId,
  stage,
  receipt,
  { at = new Date().toISOString() } = {},
) {
  const ledger = await readPublicationLedger(ledgerPath);
  const attempt = ledger.attempts[attemptId];
  if (!attempt) throw new Error(`Unknown publication attempt ${attemptId}`);
  if (attempt.state === "ROLLED_BACK") {
    throw new Error("a rolled-back publication attempt cannot be resumed");
  }
  const currentIndex = PUBLICATION_STAGES.indexOf(attempt.state);
  const desiredIndex = PUBLICATION_STAGES.indexOf(stage);
  if (desiredIndex < 0) throw new Error(`Unknown publication stage ${stage}`);
  if (desiredIndex <= currentIndex) {
    const prior = attempt.transitions.find((transition) => transition.stage === stage);
    if (!prior || canonicalJson(prior.receipt) !== canonicalJson(receipt)) {
      throw new Error(
        `Publication transition ${stage} was already recorded with different evidence`,
      );
    }
    return attempt;
  }
  if (desiredIndex !== currentIndex + 1) {
    throw new Error(`Publication transition cannot skip ${attempt.state} -> ${stage}`);
  }
  if (stage === "VERIFIED") assertCompleteVerification(receipt);
  const next = {
    ...attempt,
    state: stage,
    updatedAt: at,
    transitions: [
      ...attempt.transitions,
      { sequence: attempt.transitions.length + 1, stage, at, receipt },
    ],
  };
  await writeLedger(ledgerPath, {
    ...ledger,
    revision: ledger.revision + 1,
    attempts: { ...ledger.attempts, [attemptId]: next },
  });
  return next;
}

/**
 * Close a local candidate that was superseded before any network authority was
 * attached. Once authorized, recovery must reconcile the side-effect ledger
 * instead of pretending the attempt never happened.
 *
 * @param {string} ledgerPath
 * @param {string} attemptId
 * @param {string} reason
 * @param {{ at?: string }} [options]
 */
export async function rollBackUnapprovedPublicationAttempt(
  ledgerPath,
  attemptId,
  reason,
  { at = new Date().toISOString() } = {},
) {
  const ledger = await readPublicationLedger(ledgerPath);
  const attempt = ledger.attempts[attemptId];
  if (!attempt) throw new Error(`Unknown publication attempt ${attemptId}`);
  if (attempt.state === "ROLLED_BACK") {
    const receipt = attempt.transitions.at(-1)?.receipt;
    if (receipt?.reason !== reason) {
      throw new Error("rolled-back publication attempt has different evidence");
    }
    return attempt;
  }
  if (
    attempt.authorization !== null ||
    PUBLICATION_STAGES.indexOf(attempt.state) >= PUBLICATION_STAGES.indexOf("AUTHORIZED")
  ) {
    throw new Error("an authorized publication attempt must be recovered, not rolled back locally");
  }
  if (reason.trim().length === 0) throw new Error("publication rollback requires a reason");
  const next = {
    ...attempt,
    state: "ROLLED_BACK",
    updatedAt: at,
    transitions: [
      ...attempt.transitions,
      {
        sequence: attempt.transitions.length + 1,
        stage: "ROLLED_BACK",
        at,
        receipt: { reason },
      },
    ],
  };
  await writeLedger(ledgerPath, {
    ...ledger,
    revision: ledger.revision + 1,
    attempts: { ...ledger.attempts, [attemptId]: next },
  });
  return next;
}

/** @param {unknown} receipt */
function assertCompleteVerification(receipt) {
  const report = z
    .object({
      checkedArtifacts: z.number().int().positive(),
      verifiedArtifacts: z.number().int().positive(),
      minimumIndependentGateways: z.number().int().min(2),
      artifacts: z.array(
        z
          .object({
            verified: z.literal(true),
            matchedGateways: z.array(z.string().url()).min(2),
          })
          .passthrough(),
      ),
    })
    .passthrough()
    .parse(receipt);
  if (
    report.checkedArtifacts !== report.verifiedArtifacts ||
    report.artifacts.length !== report.checkedArtifacts
  ) {
    throw new Error("publication verification must cover every artifact");
  }
  for (const artifact of report.artifacts) {
    const hosts = new Set(
      artifact.matchedGateways.map((gateway) => new URL(gateway).host.toLowerCase()),
    );
    if (hosts.size < report.minimumIndependentGateways) {
      throw new Error("publication verification requires independent gateway hosts per artifact");
    }
  }
}

/**
 * @param {string} ledgerPath
 * @param {string} attemptId
 * @param {unknown} authorization
 * @param {string | Buffer} publicKeyPem
 * @param {{ now?: string, at?: string }} [options]
 */
export async function authorizePublicationAttempt(
  ledgerPath,
  attemptId,
  authorization,
  publicKeyPem,
  options = {},
) {
  const ledger = await readPublicationLedger(ledgerPath);
  const attempt = ledger.attempts[attemptId];
  if (!attempt) throw new Error(`Unknown publication attempt ${attemptId}`);
  if (!publicationTargetSchema.safeParse(attempt.target).success) {
    throw new Error(
      "publication attempt predates signed mode/workflow identity and cannot be authorized; prepare a new candidate",
    );
  }
  const verified = verifyPublishAuthorization(authorization, publicKeyPem, attempt.target, options);
  const consumed = ledger.consumedApprovals.find((entry) => entry.nonce === verified.payload.nonce);
  if (consumed) {
    throw new Error(
      `publication authorization nonce was already consumed by ${consumed.attemptId}`,
    );
  }
  const reserved = Object.values(ledger.attempts).find(
    (entry) =>
      entry.attemptId !== attemptId && entry.authorization?.nonce === verified.payload.nonce,
  );
  if (reserved) {
    throw new Error(`publication authorization nonce is already attached to ${reserved.attemptId}`);
  }
  const approvalDigest = digestJson(verified);
  const receipt = {
    nonce: verified.payload.nonce,
    approvalDigest,
    keyId: verified.signature.keyId,
  };
  const authorizationRecord = {
    ...receipt,
    issuedAt: verified.payload.issuedAt,
    expiresAt: verified.payload.expiresAt,
    approver: verified.payload.approver,
  };
  const currentIndex = PUBLICATION_STAGES.indexOf(attempt.state);
  const authorizedIndex = PUBLICATION_STAGES.indexOf("AUTHORIZED");
  if (currentIndex >= authorizedIndex) {
    if (
      canonicalJson(attempt.authorization) !== canonicalJson(authorizationRecord) ||
      canonicalJson(
        attempt.transitions.find((transition) => transition.stage === "AUTHORIZED")?.receipt,
      ) !== canonicalJson(receipt)
    ) {
      throw new Error("publication attempt carries different authorization evidence");
    }
    return attempt;
  }
  if (attempt.state !== "BUILT") {
    throw new Error(`publication authorization requires BUILT state, received ${attempt.state}`);
  }
  const at = options.at ?? new Date().toISOString();
  const next = {
    ...attempt,
    state: "AUTHORIZED",
    updatedAt: at,
    authorization: authorizationRecord,
    transitions: [
      ...attempt.transitions,
      {
        sequence: attempt.transitions.length + 1,
        stage: "AUTHORIZED",
        at,
        receipt,
      },
    ],
  };
  await writeLedger(ledgerPath, {
    ...ledger,
    revision: ledger.revision + 1,
    attempts: { ...ledger.attempts, [attemptId]: next },
  });
  return next;
}

/**
 * Refuse a new network side effect after an authorization's exact time window.
 * Local reconciliation and finalization may continue after expiry once the
 * corresponding side-effect receipt is already durable.
 *
 * @param {import("zod").infer<typeof attemptSchema>} attempt
 * @param {string} [now]
 */
export function assertPublicationAuthorizationActive(attempt, now = new Date().toISOString()) {
  if (!attempt.authorization) {
    throw new Error("publication attempt has no verified authorization");
  }
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error("authorization verification time is invalid");
  if (nowMs < Date.parse(attempt.authorization.issuedAt)) {
    throw new Error("publication authorization is not active yet");
  }
  if (nowMs >= Date.parse(attempt.authorization.expiresAt)) {
    throw new Error("publication authorization has expired before the next network side effect");
  }
  return attempt.authorization;
}

/**
 * Consume authority only after exact IPNS readback. A crash before this point
 * resumes the same attempt; afterward the signed document cannot start another.
 *
 * @param {string} ledgerPath @param {string} attemptId @param {{ at?: string }} [options]
 */
export async function consumePublicationAuthorization(
  ledgerPath,
  attemptId,
  { at = new Date().toISOString() } = {},
) {
  const ledger = await readPublicationLedger(ledgerPath);
  const attempt = ledger.attempts[attemptId];
  if (!attempt?.authorization) throw new Error("publication attempt has no verified authorization");
  const existing = ledger.consumedApprovals.find(
    (entry) => entry.nonce === attempt.authorization.nonce,
  );
  if (existing) {
    if (existing.attemptId !== attemptId)
      throw new Error("publication authorization replay detected");
    return attempt;
  }
  if (attempt.state !== "IPNS_VERIFIED") {
    throw new Error("publication authorization cannot be consumed before IPNS verification");
  }
  const next = {
    ...attempt,
    state: "APPROVAL_CONSUMED",
    updatedAt: at,
    transitions: [
      ...attempt.transitions,
      {
        sequence: attempt.transitions.length + 1,
        stage: "APPROVAL_CONSUMED",
        at,
        receipt: { nonce: attempt.authorization.nonce },
      },
    ],
  };
  await writeLedger(ledgerPath, {
    ...ledger,
    revision: ledger.revision + 1,
    attempts: { ...ledger.attempts, [attemptId]: next },
    consumedApprovals: [
      ...ledger.consumedApprovals,
      { nonce: attempt.authorization.nonce, attemptId, consumedAt: at },
    ],
  });
  return next;
}

/**
 * Exact readback is the last mutation gate. A missing label, wrong network key,
 * or stale CID fails before authority can be consumed.
 *
 * @param {string} ledgerPath
 * @param {string} attemptId
 * @param {{ networkKey?: string, cid?: string } | null} readback
 * @param {{ at?: string }} [options]
 */
export async function recordVerifiedIpnsReadback(ledgerPath, attemptId, readback, options = {}) {
  const ledger = await readPublicationLedger(ledgerPath);
  const attempt = ledger.attempts[attemptId];
  if (!attempt) throw new Error(`Unknown publication attempt ${attemptId}`);
  if (
    readback === null ||
    readback.networkKey !== attempt.target.ipnsNetworkKey ||
    readback.cid !== attempt.target.rootCid
  ) {
    throw new Error("IPNS readback is missing or does not match the authorized target");
  }
  return advancePublicationAttempt(
    ledgerPath,
    attemptId,
    "IPNS_VERIFIED",
    { networkKey: readback.networkKey, cid: readback.cid },
    options,
  );
}

/** @param {import("zod").infer<typeof attemptSchema>} attempt */
export function nextPublicationRecoveryAction(attempt) {
  const actions = {
    PREPARED: "freeze-candidate",
    FROZEN: "build-cars-and-manifest",
    BUILT: "await-exact-signed-authorization",
    AUTHORIZED: "upload-root-car",
    ROOT_UPLOAD_RECORDED: "upload-manifest-car",
    MANIFEST_UPLOAD_RECORDED: "pin-independent-secondary-copy",
    SECONDARY_PIN_RECORDED: "verify-all-artifacts-on-two-gateways",
    VERIFIED: "append-immutable-run-history",
    HISTORY_RECORDED: "repoint-ipns",
    IPNS_REPOINT_RECORDED: "read-back-ipns",
    IPNS_VERIFIED: "consume-authorization",
    APPROVAL_CONSUMED: "finalize-publication",
    FINALIZED: "none",
    ROLLED_BACK: "none",
  };
  return actions[attempt.state];
}
