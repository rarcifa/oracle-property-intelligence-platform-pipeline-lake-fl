#!/usr/bin/env node

import { App } from "aws-cdk-lib";

import { CountyEnrichmentBatchStack } from "./county-enrichment-batch-stack.js";
import { ClermontBaselineStack } from "./clermont-baseline-stack.js";

const app = new App();
const region = app.node.tryGetContext("region") ?? process.env.CDK_DEFAULT_REGION ?? "us-east-1";

new CountyEnrichmentBatchStack(app, "CountyEnrichmentBatchStack", {
  stackName: app.node.tryGetContext("stackName") ?? "CountyEnrichmentBatchStack",
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region,
  },
  description: "Shared operator-triggered AWS Batch scaffold for county enrichment",
});

new ClermontBaselineStack(app, "ClermontBaselineStack", {
  stackName: app.node.tryGetContext("baselineStackName") ?? "ClermontBaselineStack",
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region,
  },
  description: "Private immutable Clermont baseline store and branch-bound GitHub read role",
});
