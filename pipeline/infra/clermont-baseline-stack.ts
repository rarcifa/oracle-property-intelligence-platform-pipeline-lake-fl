import {
  CfnParameter,
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  Tags,
  type StackProps,
} from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import type { Construct } from "constructs";

import { CLERMONT_REMOTE_STORAGE_LIMIT_BYTES } from "../src/batch/clermont-contracts.js";
import {
  createPagerDutyFailureNotifier,
  pagerDutySecretArnFromContext,
} from "./pagerduty-failure-notifier.js";

const DEFAULT_REPOSITORY = "rarcifa/oracle-property-intelligence-platform-pipeline-lake-fl";
const DEFAULT_BRANCHES = ["main", "pr/lake-fl-kit-pipeline"];
const BASELINE_PREFIX = "clermont";
export const CLERMONT_BASELINE_ACCOUNT = "122610508924";
export const CLERMONT_BASELINE_REGION = "us-east-2";

function stringContext(scope: Construct, name: string, fallback: string): string {
  const value = scope.node.tryGetContext(name);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function branchContext(scope: Construct): string[] {
  const value = scope.node.tryGetContext("githubBranches");
  const branches =
    typeof value === "string"
      ? value
          .split(",")
          .map((branch) => branch.trim())
          .filter(Boolean)
      : DEFAULT_BRANCHES;
  if (branches.length === 0 || branches.some((branch) => !/^[A-Za-z0-9._/-]+$/.test(branch))) {
    throw new Error("CDK context githubBranches must contain valid comma-separated branches");
  }
  return [...new Set(branches)];
}

function alertEmailContext(scope: Construct): string {
  const value = scope.node.tryGetContext("alertEmail");
  if (typeof value !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim())) {
    throw new Error("CDK context alertEmail is required and must be a valid email address");
  }
  return value.trim();
}

/**
 * Private durable store for certified Clermont baselines.
 *
 * The operator role can append immutable baseline objects and conditionally
 * replace the versioned last-good pointer, but it cannot delete either. The
 * GitHub role is branch-bound, reads certified baselines, and may publish only
 * to the stack's alert topic. This keeps the disposable Actions runner out of
 * acquisition and promotion while still letting it consume one exact digest
 * and notify the approved email when a scheduled run fails.
 */
export class ClermontBaselineStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    if (this.account !== CLERMONT_BASELINE_ACCOUNT || this.region !== CLERMONT_BASELINE_REGION) {
      throw new Error(
        `ClermontBaselineStack is pinned to AWS account ${CLERMONT_BASELINE_ACCOUNT} in ${CLERMONT_BASELINE_REGION}`,
      );
    }
    Tags.of(this).add("project_name", "oracle-lake-fl");

    const operatorPrincipalArn = new CfnParameter(this, "BaselineOperatorArn", {
      type: "String",
      allowedPattern: "^arn:[^:]+:iam::[0-9]{12}:(user|role)/[A-Za-z0-9+=,.@_/-]+$",
      constraintDescription: "must be one exact IAM user or role ARN",
      description:
        "Existing operator principal allowed to assume the no-delete baseline writer role",
    });
    const repository = stringContext(this, "githubRepository", DEFAULT_REPOSITORY);
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
      throw new Error("CDK context githubRepository must be owner/repository");
    }
    const branches = branchContext(this);
    const alertEmail = alertEmailContext(this);
    const pagerDutySecretArn = pagerDutySecretArnFromContext(this);

    const bucket = new s3.Bucket(this, "BaselineBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
      lifecycleRules: [
        {
          id: "AbortIncompleteMultipartUploads",
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
      ],
    });

    const operatorRole = new iam.Role(this, "BaselineOperatorWriteRole", {
      assumedBy: new iam.ArnPrincipal(operatorPrincipalArn.valueAsString),
      description:
        "Append certified Clermont baseline objects and CAS-update last-good; deletion is intentionally absent",
      maxSessionDuration: Duration.hours(4),
    });
    operatorRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "s3:GetBucketLocation",
          "s3:ListBucket",
          "s3:ListBucketMultipartUploads",
          "s3:ListBucketVersions",
        ],
        resources: [bucket.bucketArn],
        conditions: {
          StringLike: {
            "s3:prefix": [BASELINE_PREFIX, `${BASELINE_PREFIX}/*`],
          },
        },
      }),
    );
    operatorRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "s3:GetObject",
          "s3:GetObjectVersion",
          "s3:PutObject",
          "s3:AbortMultipartUpload",
          "s3:ListMultipartUploadParts",
        ],
        resources: [bucket.arnForObjects(`${BASELINE_PREFIX}/*`)],
      }),
    );

    const githubProvider = new iam.OpenIdConnectProvider(this, "GitHubOidcProvider", {
      url: "https://token.actions.githubusercontent.com",
      clientIds: ["sts.amazonaws.com"],
    });
    const githubPrincipal = new iam.OpenIdConnectPrincipal(githubProvider).withConditions({
      StringEquals: {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
      },
      StringLike: {
        "token.actions.githubusercontent.com:sub": branches.map(
          (branch) => `repo:${repository}:ref:refs/heads/${branch}`,
        ),
      },
    });
    const githubReadRole = new iam.Role(this, "GitHubBaselineReadRole", {
      assumedBy: githubPrincipal,
      description: `Read certified Clermont baselines and notify operators for ${repository}`,
      maxSessionDuration: Duration.hours(1),
    });
    githubReadRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetBucketLocation", "s3:ListBucket"],
        resources: [bucket.bucketArn],
        conditions: {
          StringLike: {
            "s3:prefix": [BASELINE_PREFIX, `${BASELINE_PREFIX}/*`],
          },
        },
      }),
    );

    const alertTopic = new sns.Topic(this, "BaselineAlertTopic", {
      displayName: "Clermont baseline storage and operator alerts",
    });
    alertTopic.addSubscription(new subscriptions.EmailSubscription(alertEmail));
    alertTopic.grantPublish(operatorRole);
    alertTopic.grantPublish(githubReadRole);
    const failureNotifier = createPagerDutyFailureNotifier(this, "FailureNotifier", {
      secretArn: pagerDutySecretArn,
      component: "lake-county-ingestion",
    });
    if (failureNotifier !== null) {
      alertTopic.addSubscription(new subscriptions.LambdaSubscription(failureNotifier));
      const exactInvoke = new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: [failureNotifier.functionArn],
      });
      operatorRole.addToPolicy(exactInvoke);
      githubReadRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ["lambda:InvokeFunction"],
          resources: [failureNotifier.functionArn],
        }),
      );
    }
    const storageAlarm = new cloudwatch.Alarm(this, "BaselineStorageBudgetAlarm", {
      alarmDescription:
        "Clermont immutable baseline storage exceeded its conservative recurring-cost ceiling",
      metric: new cloudwatch.Metric({
        namespace: "AWS/S3",
        metricName: "BucketSizeBytes",
        dimensionsMap: {
          BucketName: bucket.bucketName,
          StorageType: "StandardStorage",
        },
        statistic: "Average",
        period: Duration.days(1),
      }),
      threshold: CLERMONT_REMOTE_STORAGE_LIMIT_BYTES,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    storageAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertTopic));
    storageAlarm.addOkAction(new cloudwatchActions.SnsAction(alertTopic));
    githubReadRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:GetObjectVersion"],
        resources: [bucket.arnForObjects(`${BASELINE_PREFIX}/*`)],
      }),
    );

    new CfnOutput(this, "BaselineBucketName", { value: bucket.bucketName });
    new CfnOutput(this, "BaselinePrefix", { value: BASELINE_PREFIX });
    new CfnOutput(this, "BaselineS3Uri", {
      value: `s3://${bucket.bucketName}/${BASELINE_PREFIX}`,
    });
    new CfnOutput(this, "BaselineOperatorWriteRoleArn", {
      value: operatorRole.roleArn,
    });
    new CfnOutput(this, "BaselineReadRoleArn", {
      value: githubReadRole.roleArn,
    });
    new CfnOutput(this, "GitHubOidcProviderArn", {
      value: githubProvider.openIdConnectProviderArn,
    });
    new CfnOutput(this, "BaselineAlertTopicArn", { value: alertTopic.topicArn });
    if (failureNotifier !== null) {
      new CfnOutput(this, "FailureNotifierArn", { value: failureNotifier.functionArn });
    }
    new CfnOutput(this, "PagerDutyConfigured", {
      value: failureNotifier === null ? "false" : "true",
    });
    new CfnOutput(this, "BaselineStorageLimitBytes", {
      value: String(CLERMONT_REMOTE_STORAGE_LIMIT_BYTES),
    });
  }
}
