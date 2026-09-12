import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const workflowPath = fileURLToPath(
  new URL("../../.github/workflows/pipeline.yml", import.meta.url),
);

describe("scheduled workflow publication policy", () => {
  it("requires a manual publish=true dispatch even when credentials exist", async () => {
    const workflow = await readFile(workflowPath, "utf8");
    const publishStart = workflow.indexOf("      - name: Publish to IPFS");
    const publishEnd = workflow.indexOf("      # The retrieval corpus", publishStart);
    const publishStep = workflow.slice(publishStart, publishEnd);

    expect(workflow).toContain("schedule:");
    expect(publishStep).toContain(
      "if: ${{ github.event_name == 'workflow_dispatch' && inputs.publish == true }}",
    );
    expect(publishStep).not.toMatch(/if:.*S3_ACCESS_KEY_ID/);
    expect(publishStep).toContain("PUBLISH_AUTHORIZATION_JSON_B64");
    expect(publishStep).toContain("PUBLISH_APPROVAL_PUBLIC_KEY_B64");
    expect(publishStep).toContain("SECONDARY_PIN_SERVICE_URL: https://api.pinata.cloud/psa");
    expect(publishStep).toContain("SECONDARY_PIN_SERVICE_TOKEN");
    expect(publishStep).toContain(".target.ipnsPredecessor.cid");
    expect(publishStep).toContain(".target.ipnsPredecessor.sequence");
    expect(publishStep).toContain(
      'REQUEST="data/artifacts/publish/lake/manifests/${{ steps.target.outputs.run_id }}.publication-request.json"',
    );
    expect(publishStep).not.toContain('REQUEST="pipeline/data/artifacts/publish/lake/manifests/');
    expect(publishStep).toContain('--expected-ipns-predecessor-cid "$IPNS_PREDECESSOR_CID"');
    expect(publishStep).toContain(
      '--expected-ipns-predecessor-sequence "$IPNS_PREDECESSOR_SEQUENCE"',
    );
    expect(publishStep).toContain('--approve "$APPROVAL"');
    expect(publishStep).toContain('--approval-public-key "$PUBLIC_KEY"');
    expect(workflow).not.toContain("secrets.SECONDARY_PIN_SERVICE_URL");
  });

  it("does not expose publication credentials at job scope", async () => {
    const workflow = await readFile(workflowPath, "utf8");
    const beforeSteps = workflow.slice(0, workflow.indexOf("    steps:"));
    expect(beforeSteps).not.toContain("S3_ACCESS_KEY_ID");
    expect(beforeSteps).not.toContain("FILEBASE_API_TOKEN");
  });

  it("keeps schedule and publish=false executions on the local-only branch", async () => {
    const workflow = await readFile(workflowPath, "utf8");
    const reportStart = workflow.indexOf("      - name: Report that publishing was skipped");
    const reportEnd = workflow.indexOf("      # Saved after publishing", reportStart);
    const reportStep = workflow.slice(reportStart, reportEnd);
    expect(reportStep).toContain(
      "if: ${{ github.event_name != 'workflow_dispatch' || inputs.publish != true }}",
    );
    expect(reportStep).toContain("stored credentials alone are never authority");
  });

  it("fails closed instead of manufacturing an empty Clermont export", async () => {
    const workflow = await readFile(workflowPath, "utf8");
    expect(workflow).toContain("npm run clermont:materialize");
    expect(workflow).toContain("CLERMONT_BASELINE_CONSUMPTION_REQUEST_B64");
    expect(workflow).toContain("CLERMONT_BASELINE_S3_URI");
    expect(workflow).toContain('POINTER_DIGEST="$(jq -er');
    expect(workflow).toContain(".baselineSha256");
    expect(workflow).not.toContain(".expectedBaselineSha256");
    expect(workflow).toContain('--clermont-baseline-sha256 "$DIGEST"');
    expect(workflow).not.toContain("printf 'permit_number,alternate_key,parcel_id,permit_type");
  });

  it("reads the behavioral Clermont request contract and rejects the removed legacy field", () => {
    const digest = "a".repeat(64);
    const filter = '.baselineSha256 | select(test("^[a-f0-9]{64}$"))';
    const current = spawnSync("jq", ["-er", filter], {
      input: JSON.stringify({ baselineSha256: digest }),
      encoding: "utf8",
    });
    expect(current.status).toBe(0);
    expect(current.stdout.trim()).toBe(digest);
    const legacy = spawnSync("jq", ["-er", filter], {
      input: JSON.stringify({ baseline: { requiredSha256: digest } }),
      encoding: "utf8",
    });
    expect(legacy.status).not.toBe(0);
  });

  it("does not treat best-effort GitHub caches as canonical ingestion state", async () => {
    const workflow = await readFile(workflowPath, "utf8");
    expect(workflow).not.toContain("actions/cache/");
    expect(workflow).toContain("Freeze the local publication candidate");
    expect(workflow).toContain("--dry-run");
  });

  it("invokes the secret-backed notifier and retains SNS as a secondary channel", async () => {
    const workflow = await readFile(workflowPath, "utf8");
    const assumeStart = workflow.indexOf(
      "      - name: Assume the notification role after an ingestion failure",
    );
    const notifyStart = workflow.indexOf(
      "      - name: Notify operators of a failed ingestion run",
      assumeStart,
    );
    const notifyEnd = workflow.indexOf("\n      - name:", notifyStart + 1);
    const assumeStep = workflow.slice(assumeStart, notifyStart);
    const notifyStep = workflow.slice(notifyStart, notifyEnd);

    expect(assumeStart).toBeGreaterThan(-1);
    expect(assumeStep).toContain("if: ${{ failure()");
    expect(assumeStep).toContain("CLERMONT_BASELINE_READ_ROLE_ARN");
    expect(notifyStep).toContain("CLERMONT_ALERT_TOPIC_ARN");
    expect(notifyStep).toContain("CLERMONT_FAILURE_NOTIFIER_ARN");
    expect(notifyStep).toContain("aws lambda invoke");
    expect(notifyStep).toContain("arn:aws:lambda:us-east-2:122610508924:function:");
    expect(notifyStep).toContain("lake-county-ingestion/${{ steps.target.outputs.run_id }}");
    expect(notifyStep).not.toContain('dedupKey "lake-county-ingestion/${{ github.run_id }}"');
    expect(notifyStep).toContain(".dedupKey");
    expect(notifyStep).toContain("aws sns publish");
    expect(notifyStep).toContain("this is not an on-call page");
    expect(notifyStep).not.toContain("PAGERDUTY_ROUTING_KEY");
    expect(notifyStep).not.toContain("events.pagerduty.com");
    expect(notifyStep).toContain("neither paging nor SNS notification is configured");
    expect(workflow).not.toContain("secrets.PAGERDUTY_ROUTING_KEY");
  });

  it("publishes a previously frozen artifact instead of rebuilding reviewed bytes", async () => {
    const workflow = await readFile(workflowPath, "utf8");
    expect(workflow).toContain("candidate_workflow_run_id:");
    expect(workflow).toContain("uses: actions/download-artifact@v4");
    expect(workflow).toContain("run-id: ${{ inputs.candidate_workflow_run_id }}");
    expect(workflow).toContain("name: lake-run-${{ steps.target.outputs.run_id }}");
    expect(workflow).toContain("Verify the restored candidate identity");
    expect(workflow).toContain(".target.mode == $mode");
    expect(workflow).toContain(".target.candidateWorkflowRunId == $workflow");
    expect(workflow).toContain(".target.candidateCommit == $commit");
    expect(workflow).toContain(".attempts[$id].target == $request[0].target");
    expect(workflow).toContain("pipeline/scripts/lake/publication-provenance.mjs");
    expect(workflow).toContain('--candidate-commit "${{ github.sha }}"');
    expect(workflow).toContain(
      '--candidate-commit "${{ steps.candidate.outputs.candidate_commit }}"',
    );
    expect(workflow).toContain(".publication-provenance.json");
    expect(workflow).toContain('--candidate-workflow-run-id "${{ github.run_id }}"');
    expect(workflow).toContain(
      '--candidate-workflow-run-id "${{ inputs.candidate_workflow_run_id }}"',
    );
    expect(workflow).toContain("IPNS_PREDECESSOR_RECEIPT_JSON_B64");
    expect(workflow).toContain('.label == "oracle-open-data-lake"');
    expect(workflow).toContain(
      '.network_key == "k51qzi5uqu5dgd1ekyyuhwggov571fjxof2p5ef4ke7enlq60k03r47fosb2un"',
    );
    expect(workflow.match(/--expected-ipns-predecessor-cid/g)).toHaveLength(2);
    expect(workflow.match(/--expected-ipns-predecessor-sequence/g)).toHaveLength(2);
    expect(workflow).toContain(
      "pipeline/data/artifacts/publish/lake/runs/${{ steps.target.outputs.run_id }}/",
    );

    for (const name of [
      "County readiness gate",
      "Acquire sources",
      "Build seed",
      "Restore the exact certified Clermont baseline",
      "Materialize the certified Clermont export",
      "Consolidate the query table",
      "Assemble the publish set",
    ]) {
      const start = workflow.indexOf(`      - name: ${name}`);
      expect(start, `missing workflow step ${name}`).toBeGreaterThan(-1);
      const step = workflow.slice(start, workflow.indexOf("\n      - ", start + 1));
      expect(step).toContain(
        "if: ${{ github.event_name != 'workflow_dispatch' || inputs.publish != true }}",
      );
    }
  });
});
