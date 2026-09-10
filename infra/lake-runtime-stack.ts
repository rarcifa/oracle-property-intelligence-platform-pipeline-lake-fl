/**
 * The hosted runtime: one ARM Lambda behind a Function URL.
 *
 * @module infra/lake-runtime-stack
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import {
  Architecture,
  Code,
  Function as LambdaFunction,
  FunctionUrlAuthType,
  HttpMethod,
  LoggingFormat,
  Runtime,
  Tracing,
} from "aws-cdk-lib/aws-lambda";
import { Alarm, ComparisonOperator, Metric, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import { Topic } from "aws-cdk-lib/aws-sns";
import { EmailSubscription, UrlSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import { SubscriptionProtocol } from "aws-cdk-lib/aws-sns";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { RetentionDays } from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";

/**
 * Default Secrets Manager secret holding the Anthropic API key.
 *
 * Override with `ORACLE_ANTHROPIC_SECRET_NAME`; set it to an empty string to
 * deploy without the agent, in which case `/api/chat` returns a documented 503
 * and every other surface is unaffected.
 */
const ANTHROPIC_SECRET_NAME =
  process.env.ORACLE_ANTHROPIC_SECRET_NAME ?? "oracle-lake/anthropic-api-key";

/**
 * The chat agent's key, as a CloudFormation dynamic reference.
 *
 * The key is deliberately NOT a plain environment value in this stack. It was
 * first set straight on the function with `update-function-configuration`, which
 * worked and was silently wrong: this stack declares `environment` in full, so
 * the very next `cdk deploy` would have dropped the key and taken the agent dark
 * with nothing failing loudly. Resolving it from Secrets Manager makes the
 * deploy itself carry the key, so it survives every redeploy, and the repository
 * and the synthesised template hold only `{{resolve:secretsmanager:...}}`.
 */
function anthropicKeyEnvironment(): Record<string, string> {
  if (ANTHROPIC_SECRET_NAME.length === 0) return {};
  // The NAME, not the value. This was a CloudFormation dynamic reference with
  // `unsafeUnwrap()`, which resolves at deploy time and writes the plaintext key
  // into the function's own configuration, where anyone in the account holding
  // `lambda:GetFunctionConfiguration` can read it. The function fetches the
  // secret itself at cold start instead, so the key is never in the config.
  return { ORACLE_ANTHROPIC_SECRET_ID: ANTHROPIC_SECRET_NAME };
}

/**
 * Alerting configuration.
 *
 * The engineering guidelines make paging on-call non-negotiable for critical
 * failures, and they are specific about the shape: rate signals come from one
 * self-resolving CloudWatch alarm per failure mode, fanned out to an SNS topic
 * that every channel subscribes to — email, chat, and PagerDuty's CloudWatch
 * integration URL, which maps `ALARM -> trigger` and `OK -> resolve` so an
 * incident closes itself when the condition clears.
 *
 * Every value is supplied by the deploying environment. No routing key, no
 * integration URL and no address is committed, and the PagerDuty subscription
 * is added only when the deploy is declared production — a non-prod deploy must
 * never wake on-call. What is absent is absent loudly: `AlertingConfigured` is
 * a stack output naming exactly which channels this deploy wired.
 */
const ALERT_EMAIL = process.env.ORACLE_ALERT_EMAIL ?? "";
const PAGERDUTY_CLOUDWATCH_URL = process.env.ORACLE_PAGERDUTY_CLOUDWATCH_URL ?? "";
const PAGERDUTY_SECRET_NAME = process.env.ORACLE_PAGERDUTY_SECRET_NAME ?? "";
const ALERT_ENVIRONMENT = process.env.ORACLE_ALERT_ENVIRONMENT ?? "";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/**
 * Deployment bundle, assembled by `scripts/build-lambda-bundle.mjs`.
 *
 * A plain zip asset rather than a container image, deliberately. DuckDB ships
 * native bindings, which is normally the reason to reach for a container, but a
 * container asset makes Docker a hard dependency of both `cdk synth` and
 * `cdk deploy`. The bundle script installs the Linux ARM64 bindings directly
 * instead, so the stack synthesises and deploys on a machine with no Docker at
 * all — which matters, because Docker is exactly what was unavailable here.
 */
const BUNDLE_DIR = path.join(REPO_ROOT, "infra", "bundle");

/**
 * The IPNS name the published dataset lives behind, from `artifacts/latest.json`.
 *
 * The *name*, not the CID. This deployed a CID, read from the same file, and
 * documented the tradeoff as verifiability bought at the price of needing a
 * redeploy after every publish. In a pipeline whose whole point is scheduled
 * ongoing ingestion, that price is continuity: the daily job re-points IPNS,
 * the function keeps serving the run it was deployed with, and nothing fails —
 * the data just silently stops being current. The kit's `deploy-open-data-mcp`
 * says as much: leave the CID variable unset when an IPNS name exists, so the
 * name is the single source of truth.
 *
 * Verifiability is not given up. The function resolves the name at cold start,
 * gets back an immutable CID, reads only that CID, and reports it as the run it
 * is serving — so an answer still cites bytes anyone can re-fetch and check
 * against the manifest. What changes is when the CID is learned: at boot from
 * the pointer, not at synth time from a file.
 *
 * `ORACLE_PARQUET_URL` still overrides everything, for pinning one run
 * deliberately.
 */
function publishedIpnsName(): string {
  const pointerPath = path.join(REPO_ROOT, "artifacts", "latest.json");
  const pointer: unknown = JSON.parse(readFileSync(pointerPath, "utf8"));
  const ipnsName = (pointer as { ipnsName?: unknown }).ipnsName;
  if (typeof ipnsName !== "string" || ipnsName.length === 0) {
    throw new Error(
      `${pointerPath} has no ipnsName; the function has no pointer to resolve its dataset from`,
    );
  }
  return ipnsName;
}

/** An explicitly pinned Parquet URL, when the operator set one. */
function parquetOverride(): Record<string, string> {
  const override = process.env.ORACLE_PARQUET_URL;
  return override ? { ORACLE_PARQUET_URL: override } : {};
}

export class LakeRuntimeStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const runtime = new LambdaFunction(this, "Runtime", {
      code: Code.fromAsset(BUNDLE_DIR),
      handler: "dist/lambda.handler",
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      // The dataset is materialised into memory at boot, so memory is sized for
      // the table rather than for concurrency. More memory also buys more CPU,
      // which shortens the cold start that fetches the Parquet by CID.
      memorySize: 3008,
      // Sized for the agent, not the data path. Every published-data surface
      // answers in under a second; only /api/chat runs a multi-step tool loop,
      // which measured 15-27 s idle and crossed 45 s under concurrent load.
      // Lambda bills per millisecond actually used, so a high ceiling costs
      // nothing while nobody is calling the agent, and it is the only reason
      // this is not 60 s. ORACLE_CHAT_TIMEOUT_MS must stay below it.
      timeout: Duration.seconds(150),
      environment: {
        NODE_OPTIONS: "--enable-source-maps",
        // The pointer, resolved at cold start, rather than a CID fixed at deploy
        // time. The 20 MB table is never shipped in the bundle either way; what
        // this buys is that a scheduled publish reaches the runtime on its own.
        ORACLE_IPNS_NAME: publishedIpnsName(),
        ...parquetOverride(),
        ORACLE_UI_DIST: "/var/task/public",
        ORACLE_LATEST_PATH: "/var/task/artifacts/latest.json",
        // The coverage snapshot and published schema the evidence panels read.
        // Without it `/api/meta/run` returns coverage and schema as null.
        ORACLE_RUN_DIR: "/var/task/run",
        // Lambda sets no HOME, and DuckDB resolves extensions under
        // `$HOME/.duckdb/extensions/`. Without this the first request 502s at
        // `LOAD httpfs` with "Can't find the home directory at ''". The bundle
        // ships the extension; this points DuckDB at it.
        ORACLE_DUCKDB_EXTENSION_DIR: "/var/task/duckdb-extensions",
        // Paging is gated on this being exactly "production", so a non-prod
        // deploy cannot wake on-call even with a routing key in place. The
        // routing key itself is never an environment value — only the id of
        // the secret holding it, which the function reads at runtime.
        ...(ALERT_ENVIRONMENT.length > 0 ? { ORACLE_ALERT_ENVIRONMENT: ALERT_ENVIRONMENT } : {}),
        ...(PAGERDUTY_SECRET_NAME.length > 0
          ? { ORACLE_PAGERDUTY_SECRET_ID: PAGERDUTY_SECRET_NAME }
          : {}),
        ...anthropicKeyEnvironment(),
      },
      // The Function URL is public and unauthenticated on purpose, so an
      // unbounded number of concurrent invocations is the one thing standing
      // between a scraper and the account's whole concurrency pool. This caps
      // the blast radius and the bill; the surface is a read-only open-data API,
      // not something that needs to scale to the account limit.
      reservedConcurrentExecutions: 25,
      // X-Ray, per the engineering guidelines' HIGH observability rules. This
      // deployment had no tracing, no metrics and no alarms, and that gap was
      // not recorded as a deviation either.
      tracing: Tracing.ACTIVE,
      loggingFormat: LoggingFormat.JSON,
      logRetention: RetentionDays.ONE_MONTH,
    });

    // Least privilege: read that one secret, nothing else. This is the only IAM
    // grant the stack adds beyond the default execution role.
    if (ANTHROPIC_SECRET_NAME.length > 0) {
      Secret.fromSecretNameV2(this, "AnthropicKey", ANTHROPIC_SECRET_NAME).grantRead(runtime);
    }

    // The routing key the function pages with. Least privilege: read that one
    // secret, nothing else.
    if (PAGERDUTY_SECRET_NAME.length > 0) {
      Secret.fromSecretNameV2(this, "PagerDutyRoutingKey", PAGERDUTY_SECRET_NAME).grantRead(
        runtime,
      );
    }

    // One topic, every channel. The alarms below drive it on both transitions,
    // so PagerDuty triggers on ALARM and resolves on OK without anyone
    // clearing an incident by hand.
    const alerts = new Topic(this, "Alerts", {
      topicName: "OracleLake-runtime-alerts",
      displayName: "Lake County runtime alerts",
    });
    const channels: string[] = [];
    if (ALERT_EMAIL.length > 0) {
      alerts.addSubscription(new EmailSubscription(ALERT_EMAIL));
      channels.push("email");
    }
    if (PAGERDUTY_CLOUDWATCH_URL.length > 0 && ALERT_ENVIRONMENT === "production") {
      // PagerDuty's CloudWatch integration endpoint maps ALARM -> trigger and
      // OK -> resolve, so it is one subscriber to the alarm's lifecycle rather
      // than a second mechanism with its own state.
      alerts.addSubscription(
        new UrlSubscription(PAGERDUTY_CLOUDWATCH_URL, { protocol: SubscriptionProtocol.HTTPS }),
      );
      channels.push("pagerduty");
    }

    /**
     * One self-resolving alarm per failure mode, fanned out to every channel.
     * The guidelines forbid per-item alerts, so these watch rates: a burst of
     * failures is one incident, and it closes itself when the rate returns to
     * zero.
     */
    const paging = (alarm: Alarm): Alarm => {
      alarm.addAlarmAction(new SnsAction(alerts));
      alarm.addOkAction(new SnsAction(alerts));
      return alarm;
    };

    paging(
      new Alarm(this, "RuntimeErrors", {
        alarmName: "OracleLake-runtime-errors",
        alarmDescription:
          "The Lake County runtime returned errors. Self-resolves when the error rate returns to zero.",
        metric: runtime.metricErrors({ period: Duration.minutes(5), statistic: "Sum" }),
        threshold: 1,
        evaluationPeriods: 2,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }),
    );

    paging(
      new Alarm(this, "RuntimeThrottles", {
        alarmName: "OracleLake-runtime-throttles",
        alarmDescription:
          "The runtime is being throttled against its reserved concurrency of 25, so callers are being turned away.",
        metric: runtime.metricThrottles({ period: Duration.minutes(5), statistic: "Sum" }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }),
    );

    /** A business metric the function emits, for alarming on. */
    const runtimeMetric = (metricName: string): Metric =>
      new Metric({
        namespace: "OracleLake",
        metricName,
        dimensionsMap: { service: "runtime" },
        period: Duration.minutes(5),
        statistic: "Sum",
      });

    // Terminal: the function could not open the published dataset at all, so
    // every route is failing. The function also pages directly from that path,
    // because a caller is being turned away right now; this alarm is what
    // resolves the condition when it clears.
    paging(
      new Alarm(this, "DatasetUnavailable", {
        alarmName: "OracleLake-dataset-unavailable",
        alarmDescription:
          "The runtime could not open the published dataset. Every route is failing. Self-resolves once a boot succeeds.",
        metric: runtimeMetric("DatasetUnavailable"),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }),
    );

    // Degraded, not terminal: the published pointer could not be re-resolved,
    // so the runtime is serving a verified but possibly superseded run. One
    // failure is expected — public gateways rate-limit datacenter egress — so
    // this only fires when it persists across three windows.
    paging(
      new Alarm(this, "PointerRefreshFailing", {
        alarmName: "OracleLake-pointer-refresh-failing",
        alarmDescription:
          "The published IPNS pointer has not resolved for 15 minutes, so the runtime may be serving a superseded run. Self-resolves on the next successful resolution.",
        metric: runtimeMetric("PointerRefreshFailed"),
        threshold: 1,
        evaluationPeriods: 3,
        datapointsToAlarm: 3,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }),
    );

    // There is no queue and therefore no DLQ: this is a synchronous read-only
    // HTTP surface. The guidelines' DLQ alarm rule is recorded as not
    // applicable rather than silently skipped. The pattern it mandates — one
    // stateful alarm per failure mode, fanned out to channels including
    // PagerDuty, self-resolving on recovery — is what every alarm above uses.

    new CfnOutput(this, "AlertingConfigured", {
      // Absent channels are named, not implied. A deploy with no PagerDuty
      // subscription is a deploy that cannot page, and that must be visible.
      value: channels.length > 0 ? channels.join(",") : "none",
      description:
        "Alert channels this deploy wired. Set ORACLE_ALERT_EMAIL, ORACLE_PAGERDUTY_CLOUDWATCH_URL, ORACLE_PAGERDUTY_SECRET_NAME and ORACLE_ALERT_ENVIRONMENT=production to page on-call.",
    });

    // Public and unauthenticated on purpose: this serves a published open-data
    // set. The SQL surface is locked down in two layers, in the shared SQL
    // guard and in DuckDB itself, because an open SQL endpoint over an engine
    // with filesystem access is an arbitrary-file-read primitive.
    const url = runtime.addFunctionUrl({
      authType: FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: ["*"],
        allowedMethods: [HttpMethod.GET, HttpMethod.POST],
        allowedHeaders: ["content-type"],
      },
    });

    new CfnOutput(this, "RuntimeUrl", {
      value: url.url,
      description: "Public URL: UI at /, REST at /api, MCP at /mcp",
    });
  }
}
