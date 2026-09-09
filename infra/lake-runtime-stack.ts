/**
 * The hosted runtime: one ARM Lambda behind a Function URL.
 *
 * @module infra/lake-runtime-stack
 */

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
} from "aws-cdk-lib/aws-lambda";
import { RetentionDays } from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";

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

/** Published run root CID. The runtime reads the dataset from IPFS by CID. */
const DEFAULT_PARQUET_URL =
  "https://ipfs.filebase.io/ipfs/bafybeiay65owaalyfthqnyfsmr47xmyl5bf373bylai757kbrn62rgz33q/query-table.parquet";

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
        // Read the published dataset from IPFS rather than baking it into the
        // image, so republishing a run does not require a redeploy.
        ORACLE_PARQUET_URL: process.env.ORACLE_PARQUET_URL ?? DEFAULT_PARQUET_URL,
        ORACLE_UI_DIST: "/var/task/public",
        ORACLE_LATEST_PATH: "/var/task/artifacts/latest.json",
        // Lambda sets no HOME, and DuckDB resolves extensions under
        // `$HOME/.duckdb/extensions/`. Without this the first request 502s at
        // `LOAD httpfs` with "Can't find the home directory at ''". The bundle
        // ships the extension; this points DuckDB at it.
        ORACLE_DUCKDB_EXTENSION_DIR: "/var/task/duckdb-extensions",
      },
      loggingFormat: LoggingFormat.JSON,
      logRetention: RetentionDays.ONE_MONTH,
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
