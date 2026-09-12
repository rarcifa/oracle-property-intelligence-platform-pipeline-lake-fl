#!/usr/bin/env node
/**
 * CDK application for the Lake County hosted runtime.
 *
 * CDK is the only permitted IaC tool under the engineering guidelines, and the
 * primary region is us-east-2. The stack is deliberately one Lambda behind a
 * Function URL: the dataset itself lives on IPFS and is fetched by CID, so the
 * runtime holds no database, no storage and no persistent compute, and costs
 * nothing while idle. That is what makes the assignment's "Oracle carries no
 * ongoing infrastructure cost" claim true rather than aspirational.
 *
 * @module infra/app
 */

import { App } from "aws-cdk-lib";
import {
  LAKE_RUNTIME_ACCOUNT,
  LAKE_RUNTIME_REGION,
  LakeRuntimeStack,
} from "./lake-runtime-stack.js";

function assertNodeRuntime(version = process.versions.node): void {
  const [major, minor] = version.split(".").map(Number);
  if (major !== 22 || minor === undefined || minor < 18) {
    throw new Error(`Node 22.18.0 through Node 22.x is required; received ${version}`);
  }
}

function deploymentTarget(): { account: string; region: string } {
  const account = process.env.CDK_DEFAULT_ACCOUNT;
  const region = process.env.ORACLE_DEPLOY_REGION ?? process.env.CDK_DEFAULT_REGION;
  if (account !== LAKE_RUNTIME_ACCOUNT || region !== LAKE_RUNTIME_REGION) {
    throw new Error(
      `OracleLakeRuntime deployment is pinned to AWS account ${LAKE_RUNTIME_ACCOUNT} in ${LAKE_RUNTIME_REGION}; received ${account ?? "unset"}/${region ?? "unset"}`,
    );
  }
  return { account, region };
}

assertNodeRuntime();
const target = deploymentTarget();
const app = new App();

new LakeRuntimeStack(app, "OracleLakeRuntime", {
  env: target,
  description: "Lake County FL property-intelligence runtime: UI, REST API, MCP and agent",
  tags: {
    project_name: "oracle-lake-fl",
    Project: "oracle-lake-fl",
    County: "lake",
    CostCenter: "oracle-property-intelligence",
  },
});
