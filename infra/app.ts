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
    // Pinned, not defaulted. The engineering guidelines name us-east-2 as the
    // primary region, and `CDK_DEFAULT_REGION` is populated by the CDK CLI from
    // whatever the local AWS config says — here that is us-east-1, so a
    // `?? "us-east-2"` fallback would never have fired and the stack would have
    // landed in the wrong region without anyone noticing. Override deliberately
    // with ORACLE_DEPLOY_REGION.
    region: process.env.ORACLE_DEPLOY_REGION ?? "us-east-2",
  },
  description: "Lake County FL property-intelligence runtime: UI, REST API, MCP and agent",
  tags: {
    Project: "oracle-lake-fl",
    County: "lake",
    CostCenter: "oracle-property-intelligence",
  },
});
