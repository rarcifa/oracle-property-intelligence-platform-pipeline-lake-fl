import path from "node:path";
import { fileURLToPath } from "node:url";

import { Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";

export const ALERT_PRODUCTION_ACCOUNT = "122610508924";
export const ALERT_PRODUCTION_REGION = "us-east-2";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HANDLER_ENTRY = path.join(
  REPOSITORY_ROOT,
  "packages/server/src/observability/pagerduty-notifier.ts",
);

export function pagerDutySecretArnFromContext(scope: Construct): string | null {
  const value = scope.node.tryGetContext("pagerDutySecretArn");
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new Error("CDK context pagerDutySecretArn must be one exact secret ARN");
  }
  const arn = value.trim();
  const pattern = new RegExp(
    `^arn:aws:secretsmanager:${ALERT_PRODUCTION_REGION}:${ALERT_PRODUCTION_ACCOUNT}:secret:[A-Za-z0-9/_+=.@-]+-[A-Za-z0-9]{6}$`,
  );
  if (!pattern.test(arn)) {
    throw new Error(
      `pagerDutySecretArn must name one exact Secrets Manager secret in ${ALERT_PRODUCTION_ACCOUNT}/${ALERT_PRODUCTION_REGION}`,
    );
  }
  return arn;
}

function addNotifierDashboard(scope: Construct, id: string, component: string): void {
  const metric = (metricName: string, statistic = "Sum"): cloudwatch.Metric =>
    new cloudwatch.Metric({
      namespace: "OracleLake",
      metricName,
      dimensionsMap: { service: "pagerduty-notifier" },
      period: Duration.minutes(5),
      statistic,
    });
  const dashboard = new cloudwatch.Dashboard(scope, `${id}Dashboard`, {
    dashboardName: `${Stack.of(scope).stackName}-${component}-pagerduty`,
  });
  dashboard.addWidgets(
    new cloudwatch.GraphWidget({
      title: `${component} PagerDuty delivery`,
      left: [metric("NotificationProcessed"), metric("NotificationFailed")],
      right: [metric("ProcessingDuration", "p95")],
    }),
  );
}

export function createPagerDutyFailureNotifier(
  scope: Construct,
  id: string,
  options: { secretArn: string | null; component: string },
): lambda.Function | null {
  if (options.secretArn === null) return null;
  const stack = Stack.of(scope);
  if (stack.account !== ALERT_PRODUCTION_ACCOUNT || stack.region !== ALERT_PRODUCTION_REGION) {
    throw new Error(
      `PagerDuty notifier is pinned to production account ${ALERT_PRODUCTION_ACCOUNT} in ${ALERT_PRODUCTION_REGION}`,
    );
  }
  const logGroup = new logs.LogGroup(scope, `${id}Logs`, {
    retention: logs.RetentionDays.THREE_MONTHS,
    removalPolicy: RemovalPolicy.RETAIN,
  });
  const notifier = new lambdaNodejs.NodejsFunction(scope, id, {
    runtime: lambda.Runtime.NODEJS_22_X,
    architecture: lambda.Architecture.ARM_64,
    entry: HANDLER_ENTRY,
    handler: "handler",
    depsLockFilePath: path.join(REPOSITORY_ROOT, "pnpm-lock.yaml"),
    bundling: {
      minify: true,
      sourceMap: true,
      target: "node22",
    },
    timeout: Duration.seconds(30),
    memorySize: 256,
    reservedConcurrentExecutions: 2,
    logGroup,
    loggingFormat: lambda.LoggingFormat.JSON,
    tracing: lambda.Tracing.ACTIVE,
    environment: {
      ALERT_ENVIRONMENT: "production",
      ALERT_ACCOUNT_ID: ALERT_PRODUCTION_ACCOUNT,
      ALERT_REGION: ALERT_PRODUCTION_REGION,
      ALERT_COMPONENT: options.component,
      PAGERDUTY_SECRET_ARN: options.secretArn,
    },
    description: "Pages PagerDuty once a county-ingestion failure becomes terminal",
  });
  secretsmanager.Secret.fromSecretCompleteArn(
    scope,
    `${id}RoutingKey`,
    options.secretArn,
  ).grantRead(notifier);
  addNotifierDashboard(scope, id, options.component);
  return notifier;
}
