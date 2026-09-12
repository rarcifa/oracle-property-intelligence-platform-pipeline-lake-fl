import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LAKE_RUNTIME_ACCOUNT,
  LAKE_RUNTIME_REGION,
  LakeRuntimeStack,
} from "../../infra/lake-runtime-stack.js";

const SECRET_ARN =
  "arn:aws:secretsmanager:us-east-2:122610508924:secret:oracle-lake/pagerduty-ABC123";
const saved = { ...process.env };

function configuredTemplate(): Template {
  process.env.ORACLE_ALERT_ENVIRONMENT = "production";
  process.env.ORACLE_PAGERDUTY_SECRET_ARN = SECRET_ARN;
  delete process.env.ORACLE_PAGERDUTY_CLOUDWATCH_URL;
  delete process.env.ORACLE_PAGERDUTY_SECRET_NAME;
  const app = new App();
  return Template.fromStack(
    new LakeRuntimeStack(app, "ObservedRuntime", {
      env: { account: LAKE_RUNTIME_ACCOUNT, region: LAKE_RUNTIME_REGION },
    }),
  );
}

beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key];
  }
  Object.assign(process.env, saved);
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key];
  }
  Object.assign(process.env, saved);
});

describe("hosted runtime observability", () => {
  it("makes the root CDK app reject the wrong deploy target before synthesis", () => {
    const appPath = fileURLToPath(new URL("../../infra/app.ts", import.meta.url));
    const tsxPath = fileURLToPath(new URL("../../infra/node_modules/.bin/tsx", import.meta.url));
    for (const target of [
      { CDK_DEFAULT_ACCOUNT: "000000000000", CDK_DEFAULT_REGION: LAKE_RUNTIME_REGION },
      { CDK_DEFAULT_ACCOUNT: LAKE_RUNTIME_ACCOUNT, CDK_DEFAULT_REGION: "us-east-1" },
    ]) {
      const result = spawnSync(tsxPath, [appPath], {
        env: { ...process.env, ...target, ORACLE_DEPLOY_REGION: "" },
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("deployment is pinned");
    }
  });

  it("rejects every account or region outside the production target", () => {
    const app = new App();
    expect(
      () =>
        new LakeRuntimeStack(app, "WrongAccount", {
          env: { account: "000000000000", region: LAKE_RUNTIME_REGION },
        }),
    ).toThrow(/pinned to AWS account/);
    expect(
      () =>
        new LakeRuntimeStack(app, "WrongRegion", {
          env: { account: LAKE_RUNTIME_ACCOUNT, region: "us-east-1" },
        }),
    ).toThrow(/pinned to AWS account/);
  });

  it("requires one exact production Secrets Manager ARN", () => {
    process.env.ORACLE_ALERT_ENVIRONMENT = "production";
    for (const value of [
      "oracle-lake/pagerduty",
      "arn:aws:secretsmanager:us-east-1:122610508924:secret:oracle-lake/pagerduty-ABC123",
      "arn:aws:secretsmanager:us-east-2:000000000000:secret:oracle-lake/pagerduty-ABC123",
    ]) {
      process.env.ORACLE_PAGERDUTY_SECRET_ARN = value;
      const app = new App();
      expect(
        () =>
          new LakeRuntimeStack(app, `BadSecret${value.length}`, {
            env: { account: LAKE_RUNTIME_ACCOUNT, region: LAKE_RUNTIME_REGION },
          }),
      ).toThrow(/exact Secrets Manager secret ARN/);
    }
  });

  it("uses a secret-backed Lambda subscriber to trigger and resolve alarm incidents", () => {
    const template = configuredTemplate();
    const rendered = JSON.stringify(template.toJSON());
    expect(rendered).not.toContain("ORACLE_PAGERDUTY_CLOUDWATCH_URL");
    expect(rendered).not.toContain("ORACLE_PAGERDUTY_SECRET_NAME");
    expect(rendered).not.toContain("https://events.pagerduty.com/integration/");
    template.hasResourceProperties("AWS::SNS::Subscription", {
      Protocol: "lambda",
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs22.x",
      TracingConfig: { Mode: "Active" },
      Environment: {
        Variables: Match.objectLike({
          ALERT_ENVIRONMENT: "production",
          ALERT_ACCOUNT_ID: LAKE_RUNTIME_ACCOUNT,
          ALERT_REGION: LAKE_RUNTIME_REGION,
          PAGERDUTY_SECRET_ARN: SECRET_ARN,
        }),
      },
    });
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["secretsmanager:GetSecretValue"]),
            Resource: SECRET_ARN,
          }),
        ]),
      },
    });
    template.resourceCountIs("AWS::CloudWatch::Dashboard", 1);
    expect(rendered).toContain("project_name");
    expect(rendered).toContain("oracle-lake-fl");
    expect(rendered).toContain("NotificationProcessed");
    expect(rendered).toContain("NotificationFailed");
    expect(rendered).toContain("ProcessingDuration");
  });

  it("documents secret provisioning without exposing the routing key in process arguments", () => {
    const deployGuide = readFileSync(
      fileURLToPath(new URL("../../docs/deploy.md", import.meta.url)),
      "utf8",
    );
    expect(deployGuide).toContain('--secret-string "file://$PD_SECRET_FILE"');
    expect(deployGuide).toContain("printf '%s\\n' \"$PD_ROUTING_KEY\" | jq -Rn");
    expect(deployGuide).not.toContain('--secret-string "$(jq');
    expect(deployGuide).not.toContain('--arg routing_key "$KEY"');
  });

  it("uses the CloudWatch alarm identity for the direct dataset-unavailable page", () => {
    const rendered = JSON.stringify(configuredTemplate().toJSON());
    const runtimeSource = readFileSync(
      fileURLToPath(new URL("../../packages/server/src/lambda.ts", import.meta.url)),
      "utf8",
    );
    expect(rendered).toContain("OracleLake-dataset-unavailable");
    expect(runtimeSource).toContain(
      "cloudWatchAlarmDedupKey(DATASET_UNAVAILABLE_ALARM_NAME)",
    );
    expect(runtimeSource).not.toContain("oracle-lake-runtime/dataset-unavailable/");
  });
});
