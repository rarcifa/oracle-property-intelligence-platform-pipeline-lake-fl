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
import { Alarm, ComparisonOperator, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
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
 * Published run the function reads, resolved from `artifacts/latest.json`.
 *
 * It was a hardcoded CID, beside a comment claiming a republish needed no
 * redeploy. Both halves were wrong: a pinned CID is exactly what a republish
 * does not reach, and the constant would silently keep serving an older run
 * every time the pointer moved without someone remembering to edit this line.
 *
 * Reading the pointer means a deploy always serves the newest published run and
 * cannot drift from it. It stays a CID rather than the IPNS path on purpose: a
 * CID is immutable and independently verifiable against the manifest, which is
 * the property the whole publication story rests on. A republish therefore still
 * needs a `cdk deploy` — set ORACLE_PARQUET_URL to the IPNS path to trade that
 * verifiability for following the pointer automatically.
 */
function publishedParquetUrl(): string {
  const override = process.env.ORACLE_PARQUET_URL;
  if (override) return override;
  const pointerPath = path.join(REPO_ROOT, "artifacts", "latest.json");
  const pointer: unknown = JSON.parse(readFileSync(pointerPath, "utf8"));
  const rootCid = (pointer as { rootCid?: unknown }).rootCid;
  if (typeof rootCid !== "string" || rootCid.length === 0) {
    throw new Error(`${pointerPath} has no rootCid; the function has no dataset to read`);
  }
  return `https://ipfs.filebase.io/ipfs/${rootCid}/query-table.parquet`;
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
      timeout: Duration.seconds(60),
      environment: {
        NODE_OPTIONS: "--enable-source-maps",
        // Read the published dataset from IPFS by CID rather than baking it into
        // the bundle, so the 20 MB table is never shipped and is verifiable
        // against the manifest.
        ORACLE_PARQUET_URL: publishedParquetUrl(),
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

    // One alarm per failure mode, self-resolving. The guidelines forbid
    // per-item alerts, so these watch rates and clear themselves when the rate
    // returns to zero.
    new Alarm(this, "RuntimeErrors", {
      alarmName: "OracleLake-runtime-errors",
      alarmDescription:
        "The Lake County runtime returned errors. Self-resolves when the error rate returns to zero.",
      metric: runtime.metricErrors({ period: Duration.minutes(5), statistic: "Sum" }),
      threshold: 1,
      evaluationPeriods: 2,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    new Alarm(this, "RuntimeThrottles", {
      alarmName: "OracleLake-runtime-throttles",
      alarmDescription:
        "The runtime is being throttled against its reserved concurrency of 25, so callers are being turned away.",
      metric: runtime.metricThrottles({ period: Duration.minutes(5), statistic: "Sum" }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    // There is no queue and therefore no DLQ: this is a synchronous read-only
    // HTTP surface. The guidelines' DLQ alarm rule is recorded as not
    // applicable rather than silently skipped.

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
