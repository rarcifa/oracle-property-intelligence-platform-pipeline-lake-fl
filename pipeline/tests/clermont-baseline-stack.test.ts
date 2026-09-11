import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { ClermontBaselineStack } from "../infra/clermont-baseline-stack.js";

function template(): Template {
  const app = new App({
    context: {
      githubRepository: "rarcifa/oracle-property-intelligence-platform-pipeline-lake-fl",
      githubBranches: "main,pr/lake-fl-kit-pipeline",
    },
  });
  return Template.fromStack(new ClermontBaselineStack(app, "TestClermontBaselineStack"));
}

describe("Clermont durable baseline infrastructure", () => {
  it("creates a retained private encrypted versioned bucket", () => {
    template().hasResourceProperties("AWS::S3::Bucket", {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          {
            ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" },
          },
        ],
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      VersioningConfiguration: { Status: "Enabled" },
    });
    template().hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
    });
  });

  it("uses branch-bound GitHub OIDC and gives the workflow read-only access", () => {
    const rendered = JSON.stringify(template().toJSON());
    expect(rendered).toContain("token.actions.githubusercontent.com");
    expect(rendered).toContain(
      "repo:rarcifa/oracle-property-intelligence-platform-pipeline-lake-fl:ref:refs/heads/pr/lake-fl-kit-pipeline",
    );
    expect(rendered).toContain(
      "repo:rarcifa/oracle-property-intelligence-platform-pipeline-lake-fl:ref:refs/heads/main",
    );

    template().hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["s3:GetObject", "s3:GetObjectVersion"]),
            Effect: "Allow",
          }),
        ]),
      },
    });
    expect(rendered).not.toContain("s3:DeleteObject");
  });

  it("requires the exact operator principal as a deployment parameter", () => {
    template().hasParameter("BaselineOperatorArn", {
      Type: "String",
      AllowedPattern: Match.stringLikeRegexp("iam"),
    });
  });
});
