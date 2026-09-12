import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import {
  COUNTY_ENRICHMENT_ACCOUNT,
  COUNTY_ENRICHMENT_REGION,
  CountyEnrichmentBatchStack,
} from "../infra/county-enrichment-batch-stack.js";
import {
  ALERT_PRODUCTION_ACCOUNT,
  ALERT_PRODUCTION_REGION,
} from "../infra/pagerduty-failure-notifier.js";

describe("county enrichment Batch IAM", () => {
  it("uses ledger-only operator prefixes and no fixed final-manifest key", () => {
    const app = new App({
      context: {
        alertEmail: "alerts@example.test",
        maxCostCeilingUsd: 5,
      },
    });
    const stack = new CountyEnrichmentBatchStack(app, "TestCountyEnrichmentBatchStack", {
      env: { account: COUNTY_ENRICHMENT_ACCOUNT, region: COUNTY_ENRICHMENT_REGION },
    });
    const rendered = JSON.stringify(Template.fromStack(stack).toJSON());

    expect(rendered).toContain("runs/*/submissions/*");
    expect(rendered).toContain("runs/*/recoveries/*");
    expect(rendered).toContain("OperatorSubmissionPolicyArn");
    expect(rendered).not.toContain("final-manifest.json");
  });

  it("rejects synthesis outside the pinned production account and region", () => {
    const context = { alertEmail: "alerts@example.test", maxCostCeilingUsd: 5 };
    expect(
      () =>
        new CountyEnrichmentBatchStack(new App({ context }), "WrongAccount", {
          env: { account: "000000000000", region: COUNTY_ENRICHMENT_REGION },
        }),
    ).toThrow(/pinned to AWS account/);
    expect(
      () =>
        new CountyEnrichmentBatchStack(new App({ context }), "WrongRegion", {
          env: { account: COUNTY_ENRICHMENT_ACCOUNT, region: "us-east-1" },
        }),
    ).toThrow(/pinned to AWS account/);
  });

  it("rejects a project tag that would split the cost metric dimension", () => {
    const app = new App({
      context: {
        alertEmail: "alerts@example.test",
        maxCostCeilingUsd: 5,
        projectName: "drifted-project",
      },
    });
    expect(
      () =>
        new CountyEnrichmentBatchStack(app, "WrongProject", {
          env: { account: COUNTY_ENRICHMENT_ACCOUNT, region: COUNTY_ENRICHMENT_REGION },
        }),
    ).toThrow(/projectName must be exactly county-enrichment/);
  });

  it("routes terminal Batch failures through the production-gated secret-backed notifier", () => {
    const secretArn =
      "arn:aws:secretsmanager:us-east-2:122610508924:secret:oracle-lake/pagerduty-ABC123";
    const app = new App({
      context: {
        alertEmail: "alerts@example.test",
        maxCostCeilingUsd: 5,
        pagerDutySecretArn: secretArn,
      },
    });
    const stack = new CountyEnrichmentBatchStack(app, "PagedCountyEnrichmentBatchStack", {
      env: { account: ALERT_PRODUCTION_ACCOUNT, region: ALERT_PRODUCTION_REGION },
    });
    const rendered = JSON.stringify(Template.fromStack(stack).toJSON());

    expect(rendered).toContain("Batch Job State Change");
    expect(rendered).toContain('"status":["FAILED"]');
    expect(rendered).toContain("FailureNotifierArn");
    expect(rendered).toContain("lambda:InvokeFunction");
    expect(rendered).toContain("secretsmanager:GetSecretValue");
    expect(rendered).toContain(secretArn);
    expect(rendered).toContain('"ALERT_ENVIRONMENT":"production"');
    expect(rendered).toContain('"TracingConfig":{"Mode":"Active"}');
    expect(rendered).toContain('"RetentionInDays":90');
    expect(rendered).toContain("AWS::CloudWatch::Dashboard");
    expect(rendered).not.toContain("ZipFile");
  });

  it("dashboards the exact per-worker Powertools business metrics", () => {
    const app = new App({
      context: {
        alertEmail: "alerts@example.test",
        maxCostCeilingUsd: 5,
      },
    });
    const stack = new CountyEnrichmentBatchStack(app, "ObservedWorkers", {
      env: { account: COUNTY_ENRICHMENT_ACCOUNT, region: COUNTY_ENRICHMENT_REGION },
    });
    const rendered = JSON.stringify(Template.fromStack(stack).toJSON());

    expect(rendered).toContain("OracleLake-county-enrichment-workers");
    for (const service of [
      "county-enrichment-sunbiz",
      "county-enrichment-bbb",
      "county-enrichment-reconciliation",
      "county-enrichment-permit",
    ]) {
      expect(rendered).toContain(service);
    }
    for (const metric of ["StageProcessed", "StageFailed", "ProcessingDuration"]) {
      expect(rendered).toContain(metric);
    }
    expect(rendered).toContain("CostPredicted");
    expect(rendered).toContain("ORACLE_METRIC_ENVIRONMENT");
    expect(rendered).toContain("ORACLE_METRIC_OPERATION");
    expect(rendered).toContain("ORACLE_PROJECT_NAME");
  });
});
