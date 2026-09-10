/**
 * The human approval gate that governs publication.
 *
 * Bulk property data going to public IPFS is human-gated. `county-open-data-publish`
 * and `durable-workflow-builder` pattern 10 specify the state machine exactly:
 * an unapproved `tick()` dry-runs — export and validate, no upload, no IPNS
 * write — and LEAVES `pending=true`; `approve()` is a human action and arms an
 * immediate tick when pending; `pending` clears only after a successful
 * APPROVED publication. An unapproved tick dry-runs once per content watermark
 * and then stops, so nothing rebuilds a multi-hundred-megabyte export on a loop
 * while it waits for a human.
 *
 * This runtime has no Restate ingress, so there is no virtual object to hold
 * that state. It was therefore implemented beside the publisher instead of in
 * front of it: `filebase.mjs` could check an approval manifest, and the Lake
 * publisher never called it — it uploaded directly. A gate the publish path
 * does not go through is not a gate. This module is that state machine, and
 * `scripts/lake/publish-run.mjs` cannot reach an upload without passing it.
 *
 * The state is a JSON file under `artifacts/`, committed with the repository.
 * That is deliberate: an approval is a durable human decision that must survive
 * a runner being destroyed — a scheduled publish runs on a fresh machine every
 * time — and keeping it in version control makes who approved what, and when,
 * reviewable in the same history as the data it released.
 *
 * @module core/publish-gate
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/** Schema version stamped into every gate document this runtime writes. */
export const PUBLISH_GATE_SCHEMA_VERSION = "elephant.publish-gate.v1";

const COUNTY_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const isoTimestamp = z
  .string()
  .regex(ISO_TIMESTAMP_PATTERN, "must be an ISO-8601 UTC timestamp");

/** One county's gate state. */
export const countyGateSchema = z
  .object({
    /** A publication has been requested and has not yet been released. */
    pending: z.boolean(),
    /** A human has approved publication for this county. */
    approved: z.boolean(),
    approvedBy: z.string().trim().min(1).nullable(),
    approvedAt: isoTimestamp.nullable(),
    /** What the approver was told they were approving. */
    approvalNote: z.string().trim().min(1).nullable(),
    /**
     * Who physically wrote this record, when that is not the approver.
     *
     * A file-based gate cannot prove a human typed into it: anything that can
     * run the CLI can pass `--by`. When an automated process records an
     * approval it was given out-of-band, it must say so here, so the file never
     * claims more provenance than it has. Null means the approver ran it.
     */
    recordedBy: z.string().trim().min(1).nullable().default(null),
    /** Content watermark of the last unapproved dry run, so it happens once. */
    lastDryRunWatermark: z.string().trim().min(1).nullable(),
    /** Content watermark of the last approved publication. */
    lastPublishedWatermark: z.string().trim().min(1).nullable(),
    lastPublishedRunId: z.string().trim().min(1).nullable(),
    lastPublishedAt: isoTimestamp.nullable(),
  })
  .strict();

/** The gate document as written to disk. */
export const publishGateSchema = z
  .object({
    schemaVersion: z.literal(PUBLISH_GATE_SCHEMA_VERSION),
    counties: z.record(
      z.string().regex(COUNTY_KEY_PATTERN, "must be normalized lowercase kebab-case"),
      countyGateSchema,
    ),
  })
  .strict();

/** A county with no recorded state: nothing requested, nothing approved. */
export const EMPTY_COUNTY_GATE = Object.freeze({
  pending: false,
  approved: false,
  approvedBy: null,
  approvedAt: null,
  approvalNote: null,
  recordedBy: null,
  lastDryRunWatermark: null,
  lastPublishedWatermark: null,
  lastPublishedRunId: null,
  lastPublishedAt: null,
});

/**
 * @param {import("zod").ZodError} error validation error
 * @returns {string}
 */
function describeIssues(error) {
  return error.issues
    .map((issue) => `${issue.path.length === 0 ? "<root>" : issue.path.join(".")}: ${issue.message}`)
    .join("; ");
}

/**
 * Validate a gate document, throwing one clear error.
 *
 * @param {unknown} value candidate document
 * @returns {import("zod").infer<typeof publishGateSchema>}
 */
export function validatePublishGate(value) {
  const result = publishGateSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid publish gate: ${describeIssues(result.error)}`);
  }
  return result.data;
}

/**
 * Read the gate document, treating a missing file as an empty one.
 *
 * @param {string} gatePath path to the gate JSON file
 * @returns {Promise<import("zod").infer<typeof publishGateSchema>>}
 */
export async function readPublishGate(gatePath) {
  let text;
  try {
    text = await readFile(gatePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { schemaVersion: PUBLISH_GATE_SCHEMA_VERSION, counties: {} };
    }
    throw error;
  }
  return validatePublishGate(JSON.parse(text));
}

/**
 * One county's state, defaulted when the county is not recorded yet.
 *
 * @param {string} gatePath path to the gate JSON file
 * @param {string} county normalized county key
 * @returns {Promise<import("zod").infer<typeof countyGateSchema>>}
 */
export async function readCountyGate(gatePath, county) {
  const gate = await readPublishGate(gatePath);
  return { ...EMPTY_COUNTY_GATE, ...(gate.counties[county] ?? {}) };
}

/**
 * Apply a change to one county and write the document back atomically.
 *
 * @param {string} gatePath path to the gate JSON file
 * @param {string} county normalized county key
 * @param {(current: import("zod").infer<typeof countyGateSchema>) => Record<string, unknown>} change
 *   receives the county's current state and returns the fields to merge
 * @returns {Promise<import("zod").infer<typeof countyGateSchema>>} the written state
 */
export async function updateCountyGate(gatePath, county, change) {
  const gate = await readPublishGate(gatePath);
  const current = { ...EMPTY_COUNTY_GATE, ...(gate.counties[county] ?? {}) };
  const next = { ...current, ...change(current) };
  const document = validatePublishGate({
    ...gate,
    schemaVersion: PUBLISH_GATE_SCHEMA_VERSION,
    counties: { ...gate.counties, [county]: next },
  });
  const body = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
  await mkdir(path.dirname(gatePath), { recursive: true });
  const temporaryPath = `${gatePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, body);
  await rename(temporaryPath, gatePath);
  return document.counties[county];
}

/**
 * Mark a county as wanting to publish. Idempotent.
 *
 * @param {string} gatePath path to the gate JSON file
 * @param {string} county normalized county key
 * @returns {Promise<import("zod").infer<typeof countyGateSchema>>}
 */
export async function requestPublish(gatePath, county) {
  return updateCountyGate(gatePath, county, () => ({ pending: true }));
}

/**
 * Record a human's approval. This is the only handler a human calls.
 *
 * @param {string} gatePath path to the gate JSON file
 * @param {string} county normalized county key
 * @param {{ approvedBy: string, note: string, at?: string, recordedBy?: string }} approval who approved, what they were told, and who wrote the record if not them
 * @returns {Promise<import("zod").infer<typeof countyGateSchema>>}
 */
export async function approvePublish(gatePath, county, approval) {
  if (typeof approval?.approvedBy !== "string" || approval.approvedBy.trim().length === 0) {
    throw new Error("An approval must name the human who gave it");
  }
  if (typeof approval?.note !== "string" || approval.note.trim().length === 0) {
    throw new Error("An approval must record what was approved");
  }
  return updateCountyGate(gatePath, county, () => ({
    approved: true,
    approvedBy: approval.approvedBy.trim(),
    approvedAt: approval.at ?? new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z"),
    approvalNote: approval.note.trim(),
    recordedBy:
      typeof approval.recordedBy === "string" && approval.recordedBy.trim().length > 0
        ? approval.recordedBy.trim()
        : null,
    // A fresh approval re-arms the dry-run throttle, so the next run acts on it
    // rather than reporting the watermark as already handled.
    lastDryRunWatermark: null,
  }));
}

/**
 * Withdraw approval. Publication returns to dry-running.
 *
 * @param {string} gatePath path to the gate JSON file
 * @param {string} county normalized county key
 * @returns {Promise<import("zod").infer<typeof countyGateSchema>>}
 */
export async function revokePublishApproval(gatePath, county) {
  return updateCountyGate(gatePath, county, () => ({
    approved: false,
    approvedBy: null,
    approvedAt: null,
    approvalNote: null,
    recordedBy: null,
    lastDryRunWatermark: null,
  }));
}

/**
 * Decide what a publish attempt may do at this content watermark.
 *
 * `publish` — approved, upload and re-point IPNS.
 * `dry-run` — not approved: build and validate, upload nothing, leave pending.
 * `skip`    — not approved and this exact content was already dry-run, so
 *             there is nothing new to prove and no reason to rebuild it.
 * `published` — this exact content is already released; re-releasing it would
 *             re-upload an identical DAG for an identical CID.
 *
 * @param {import("zod").infer<typeof countyGateSchema>} state current county state
 * @param {string} watermark content watermark, i.e. the run's root CID
 * @returns {{ action: "publish" | "dry-run" | "skip" | "published", reason: string }}
 */
export function evaluatePublishGate(state, watermark) {
  if (typeof watermark !== "string" || watermark.length === 0) {
    throw new TypeError("A content watermark is required to evaluate the publish gate");
  }
  if (state.lastPublishedWatermark === watermark) {
    return {
      action: "published",
      reason: `content ${watermark} is already published; republishing it would upload an identical DAG`,
    };
  }
  if (state.approved) {
    return {
      action: "publish",
      reason: state.recordedBy
        ? `approved by ${state.approvedBy ?? "unknown"} (recorded by ${state.recordedBy})`
        : `approved by ${state.approvedBy ?? "unknown"}`,
    };
  }
  if (state.lastDryRunWatermark === watermark) {
    return {
      action: "skip",
      reason: `content ${watermark} was already dry-run and is still awaiting approval`,
    };
  }
  return {
    action: "dry-run",
    reason: "publication is not approved for this county",
  };
}

/**
 * Record that an unapproved run dry-ran this content. `pending` stays true.
 *
 * @param {string} gatePath path to the gate JSON file
 * @param {string} county normalized county key
 * @param {string} watermark content watermark that was dry-run
 * @returns {Promise<import("zod").infer<typeof countyGateSchema>>}
 */
export async function recordDryRun(gatePath, county, watermark) {
  return updateCountyGate(gatePath, county, () => ({
    pending: true,
    lastDryRunWatermark: watermark,
  }));
}

/**
 * Record a successful approved publication. This is the only thing that clears
 * `pending`.
 *
 * @param {string} gatePath path to the gate JSON file
 * @param {string} county normalized county key
 * @param {{ watermark: string, runId: string, at?: string }} publication what was released
 * @returns {Promise<import("zod").infer<typeof countyGateSchema>>}
 */
export async function recordPublication(gatePath, county, publication) {
  return updateCountyGate(gatePath, county, (current) => {
    if (!current.approved) {
      throw new Error(
        `Refusing to record a publication for ${county}: the gate is not approved, so this run must not have uploaded`,
      );
    }
    return {
      pending: false,
      lastPublishedWatermark: publication.watermark,
      lastPublishedRunId: publication.runId,
      lastPublishedAt:
        publication.at ?? new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z"),
    };
  });
}
