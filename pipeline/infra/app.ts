#!/usr/bin/env node

import { App } from "aws-cdk-lib";

import {
  COUNTY_ENRICHMENT_ACCOUNT,
  COUNTY_ENRICHMENT_REGION,
  CountyEnrichmentBatchStack,
} from "./county-enrichment-batch-stack.js";
import { ClermontBaselineStack } from "./clermont-baseline-stack.js";

const app = new App();
const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = app.node.tryGetContext("region") ?? process.env.CDK_DEFAULT_REGION;
if (account !== COUNTY_ENRICHMENT_ACCOUNT || region !== COUNTY_ENRICHMENT_REGION) {
  throw new Error(
    `Pipeline CDK app is pinned to AWS account ${COUNTY_ENRICHMENT_ACCOUNT} in ${COUNTY_ENRICHMENT_REGION}; received ${account ?? "unset"}/${region ?? "unset"}`,
  );
}

new CountyEnrichmentBatchStack(app, "CountyEnrichmentBatchStack", {
  stackName: app.node.tryGetContext("stackName") ?? "CountyEnrichmentBatchStack",
  env: {
    account,
    region,
  },
  description: "Shared operator-triggered AWS Batch scaffold for county enrichment",
});

new ClermontBaselineStack(app, "ClermontBaselineStack", {
  stackName: app.node.tryGetContext("baselineStackName") ?? "ClermontBaselineStack",
  env: {
    account: "122610508924",
    region: "us-east-2",
  },
  description: "Private immutable Clermont baseline store and branch-bound GitHub read/alert role",
});
