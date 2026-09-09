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
import { LakeRuntimeStack } from "./lake-runtime-stack.js";

const app = new App();

new LakeRuntimeStack(app, "OracleLakeRuntime", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-2",
  },
  description: "Lake County FL property-intelligence runtime: UI, REST API, MCP and agent",
  tags: {
    Project: "oracle-lake-fl",
    County: "lake",
    CostCenter: "oracle-property-intelligence",
  },
});
