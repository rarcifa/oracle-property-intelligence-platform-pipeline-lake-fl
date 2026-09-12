import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import {
  CLERMONT_BASELINE_ACCOUNT,
  CLERMONT_BASELINE_REGION,
  ClermontBaselineStack,
} from "../infra/clermont-baseline-stack.js";

const PAGERDUTY_SECRET_ARN =
  "arn:aws:secretsmanager:us-east-2:122610508924:secret:oracle-lake/pagerduty-ABC123";

function template(context: Record<string, unknown> = {}): Template {
  const app = new App({
    context: {
      githubRepository: "rarcifa/oracle-property-intelligence-platform-pipeline-lake-fl",
      githubBranches: "main,pr/lake-fl-kit-pipeline",
      alertEmail: "alerts@example.test",
      ...context,
    },
  });
  return Template.fromStack(
    new ClermontBaselineStack(app, "TestClermontBaselineStack", {
      env: { account: CLERMONT_BASELINE_ACCOUNT, region: CLERMONT_BASELINE_REGION },
    }),
  );
}

describe("Clermont durable baseline infrastructure", () => {
  it("creates a retained private encrypted versioned bucket", () => {
    const rendered = JSON.stringify(template().toJSON());
    expect(rendered).toContain("project_name");
    expect(rendered).toContain("oracle-lake-fl");
    template().hasResourceProperties("AWS::S3::Bucket", {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          {
            ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" },
          },
        ],
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      VersioningConfiguration: { Status: "Enabled" },
    });
    template().hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
    });
  });

  it("uses branch-bound GitHub OIDC and limits the workflow to baseline reads and alerts", () => {
    const rendered = JSON.stringify(template().toJSON());
    expect(rendered).toContain("token.actions.githubusercontent.com");
    expect(rendered).toContain(
      "repo:rarcifa/oracle-property-intelligence-platform-pipeline-lake-fl:ref:refs/heads/pr/lake-fl-kit-pipeline",
    );
    expect(rendered).toContain(
      "repo:rarcifa/oracle-property-intelligence-platform-pipeline-lake-fl:ref:refs/heads/main",
    );

    template().hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["s3:GetObject", "s3:GetObjectVersion"]),
            Effect: "Allow",
          }),
        ]),
      },
    });
    template().hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([Match.objectLike({ Action: "sns:Publish", Effect: "Allow" })]),
      },
      Roles: Match.arrayWith([
        {
          Ref: Match.stringLikeRegexp("GitHubBaselineReadRole"),
        },
      ]),
    });
    expect(rendered).not.toContain("s3:DeleteObject");
  });

  it("requires the exact operator principal as a deployment parameter", () => {
    template().hasParameter("BaselineOperatorArn", {
      Type: "String",
      AllowedPattern: Match.stringLikeRegexp("iam"),
    });
  });

  it("lets the operator inventory every retained object version without deletion rights", () => {
    const rendered = JSON.stringify(template().toJSON());
    expect(rendered).toContain("s3:ListBucketVersions");
    expect(rendered).not.toContain("s3:DeleteObject");
    expect(rendered).not.toContain("s3:DeleteObjectVersion");
  });

  it("alerts the approved email when retained baseline storage exceeds its ceiling", () => {
    template().hasResourceProperties("AWS::SNS::Subscription", {
      Protocol: "email",
      Endpoint: "alerts@example.test",
    });
    template().hasResourceProperties("AWS::CloudWatch::Alarm", {
      MetricName: "BucketSizeBytes",
      Namespace: "AWS/S3",
      ComparisonOperator: "GreaterThanThreshold",
      Threshold: 150 * 1024 ** 3,
      EvaluationPeriods: 1,
      AlarmActions: Match.arrayWith([{ Ref: Match.stringLikeRegexp("BaselineAlertTopic") }]),
      OKActions: Match.arrayWith([{ Ref: Match.stringLikeRegexp("BaselineAlertTopic") }]),
    });
    template().hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([Match.objectLike({ Action: "sns:Publish", Effect: "Allow" })]),
      },
    });
  });

  it("rejects synthesis outside the owner-approved account and region", () => {
    const app = new App({ context: { alertEmail: "alerts@example.test" } });
    expect(
      () =>
        new ClermontBaselineStack(app, "WrongRegion", {
          env: { account: CLERMONT_BASELINE_ACCOUNT, region: "us-east-1" },
        }),
    ).toThrow(/pinned to AWS account/);
    expect(
      () =>
        new ClermontBaselineStack(app, "WrongAccount", {
          env: { account: "000000000000", region: CLERMONT_BASELINE_REGION },
        }),
    ).toThrow(/pinned to AWS account/);
  });

  it("bundles the typed traced notifier and grants both exact roles invocation", () => {
    const configured = template({ pagerDutySecretArn: PAGERDUTY_SECRET_ARN });
    configured.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs22.x",
      TracingConfig: { Mode: "Active" },
      Environment: {
        Variables: {
          ALERT_ENVIRONMENT: "production",
          ALERT_ACCOUNT_ID: CLERMONT_BASELINE_ACCOUNT,
          ALERT_REGION: CLERMONT_BASELINE_REGION,
          ALERT_COMPONENT: "lake-county-ingestion",
          PAGERDUTY_SECRET_ARN,
        },
      },
    });
    configured.hasResourceProperties("AWS::SNS::Subscription", {
      Protocol: "lambda",
      Endpoint: {
        "Fn::GetAtt": [Match.stringLikeRegexp("FailureNotifier"), "Arn"],
      },
    });
    configured.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmActions: Match.arrayWith([{ Ref: Match.stringLikeRegexp("BaselineAlertTopic") }]),
      OKActions: Match.arrayWith([{ Ref: Match.stringLikeRegexp("BaselineAlertTopic") }]),
    });
    configured.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["secretsmanager:GetSecretValue"]),
            Effect: "Allow",
            Resource: PAGERDUTY_SECRET_ARN,
          }),
        ]),
      },
    });
    const rendered = JSON.stringify(configured.toJSON());
    expect(rendered).not.toContain("ZipFile");
    for (const role of ["GitHubBaselineReadRole", "BaselineOperatorWriteRole"]) {
      expect(rendered).toMatch(new RegExp(`${role}[^}]*`, "s"));
    }
    const invokeStatements = Object.values(configured.findResources("AWS::IAM::Policy")).flatMap(
      (policy) =>
        (policy as { Properties?: { PolicyDocument?: { Statement?: unknown[] } } }).Properties
          ?.PolicyDocument?.Statement ?? [],
    );
    expect(
      invokeStatements.filter(
        (statement) =>
          (statement as { Action?: unknown }).Action === "lambda:InvokeFunction" &&
          JSON.stringify((statement as { Resource?: unknown }).Resource).includes(
            "FailureNotifier",
          ),
      ),
    ).toHaveLength(2);
    for (const statement of invokeStatements.filter(
      (candidate) => (candidate as { Action?: unknown }).Action === "lambda:InvokeFunction",
    )) {
      expect((statement as { Resource?: unknown }).Resource).toEqual({
        "Fn::GetAtt": [expect.stringContaining("FailureNotifier"), "Arn"],
      });
    }
    configured.hasResourceProperties("AWS::Logs::LogGroup", {
      RetentionInDays: 90,
    });
    configured.resourceCountIs("AWS::CloudWatch::Dashboard", 1);
    configured.hasOutput("PagerDutyConfigured", { Value: "true" });
    configured.hasOutput("FailureNotifierArn", {});
    template().hasOutput("PagerDutyConfigured", { Value: "false" });
  });

  it("rejects a PagerDuty secret outside the pinned production account and region", () => {
    expect(() =>
      template({
        pagerDutySecretArn:
          "arn:aws:secretsmanager:us-east-1:122610508924:secret:oracle-lake/pagerduty-ABC123",
      }),
    ).toThrow(/exact Secrets Manager secret/);
  });
});
