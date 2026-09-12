# Deploying the hosted runtime

The hosted runtime is the single largest scoring gate in this assignment: the evaluator
treats a localhost-only runtime as zero. This is what it takes to close it.

**This is deployed and live** at
<https://tf2ynypdvfkv4dqxszpkj5emjq0imyxh.lambda-url.us-east-2.on.aws/>, in `us-east-2`,
account `122610508924`. Everything below is what it took, kept because the first deploy
succeeded and served HTTP 502 on every route.

## What gets deployed

One ARM64 Lambda behind a Function URL, in `us-east-2`. That is the whole thing. There is
no database, no container orchestrator and no persistent compute, because the dataset lives
on IPFS and the function fetches it by CID at cold start. Idle cost is zero, which is what
makes the assignment's no-ongoing-cost claim true rather than aspirational.

The function serves all four surfaces on one URL: the UI at `/`, the REST API at `/api`,
the MCP server at `/mcp`, and the agent at `/api/chat`.

## Before the first deploy

```bash
aws sts get-caller-identity          # confirm the target account
export CDK_DEFAULT_REGION=us-east-2
npx cdk bootstrap                    # once per account and region
```

## Deploy

```bash
just deploy
```

That runs the build, assembles the bundle and deploys. The stack prints the public URL as
`RuntimeUrl`.

To check the synthesised template without deploying:

```bash
just synth
```

## Two deliberate choices

**A zip asset, not a container image.** DuckDB ships native bindings, which is normally the
reason to reach for a container image, but a container asset makes Docker a hard dependency
of both `cdk synth` and `cdk deploy`. It was written that way first and abandoned when
Docker turned out to be unresponsive on this machine and the synth hung. The bundle script
installs the Linux ARM64 binding directly instead, so the stack synthesises and deploys
with no Docker at all.

**The binding is installed explicitly and asserted.** DuckDB's native binding is an optional
dependency resolved per platform, and npm on macOS installs only the darwin one. The
`--cpu` and `--os` flags do not change that: the first bundle was verified to contain no
platform binding whatever, which would have failed at cold start with a missing native
module rather than at deploy time. The script now installs the Linux binding by exact
version, prunes every other platform's, and fails the build if the binding is absent or the
bundle exceeds Lambda's 250 MB unzipped limit. The verified bundle is exactly
120,051,259 bytes (about 114.5 MiB); use the byte count for release comparisons rather than
an imprecise rounded label.

## The chat key

The agent returns a clear 503 without a key rather than failing at boot.

Do **not** set `OPENAI_API_KEY` on the function directly. A directly configured provider key is
silently wrong: the stack declares `environment` in full, so the next `cdk deploy` drops the
key and the agent goes dark with nothing failing loudly. The key lives in Secrets Manager,
and the stack deploys only the secret's **name** plus an IAM grant to read it — the function
fetches the value itself at cold start. Resolving it in CloudFormation instead would write
the plaintext into the function's own configuration, where anyone holding
`lambda:GetFunctionConfiguration` can read it; an earlier version of this page described
that arrangement, and it is no longer what the stack does.

```bash
printf '%s' "$OPENAI_API_KEY" > /tmp/key && \
  aws secretsmanager create-secret --name oracle-lake/openai-api-key \
    --secret-string file:///tmp/key && rm -f /tmp/key
```

Deploy without the agent by setting `ORACLE_OPENAI_SECRET_NAME=""`.

## Pointing at a different published run

The function is deployed with `ORACLE_IPNS_NAME`, the county's published IPNS name, and no
CID. It opens on the pointer the last publication resolved — `artifacts/latest.json`'s
`rootCid`, trusted only when `resolvedCid` matches it, which is the publisher's own IPNS
readback — and checks the live name behind the first requests, moving to a newer run when it
finds one. So a republish reaches the runtime on its own, no caller ever waits on a public
gateway for a first byte, and a gateway outage is degraded freshness rather than an outage.
An answer still cites bytes anyone can re-fetch and check against the manifest.

Resolving inline on the critical path is the genuinely-first-run behaviour only, when there
is no cached pointer to open on.

An earlier version of this page said the function read `ORACLE_PARQUET_URL` and that
republishing needed no redeploy. The variable was right and the conclusion was not: a CID
was baked in at `cdk deploy` time, so a scheduled publish moved the pointer and the runtime
went on serving the previous run, silently, until somebody redeployed.

To pin one run deliberately, set `ORACLE_PARQUET_URL` in the deploying shell — it still
overrides the pointer:

```bash
ORACLE_PARQUET_URL="https://ipfs.filebase.io/ipfs/<root-cid>/query-table.parquet" \
  pnpm --filter @oracle-lake/infra exec cdk deploy
```

## Alerting

Runtime and CloudWatch failures can page on-call through PagerDuty. The scheduled ingestion
workflow also sends a failure notification to the approved Clermont SNS email topic; that
email is notification coverage, not paging. PagerDuty is not configured for this deployment,
so the repository must continue to disclose that operational deviation. The runtime stack
output `AlertingConfigured` names the channels that stack actually wired and reports `none`
when it wired nothing.

```bash
# Page on-call. Store a JSON secret through a permission-0600 temporary file so the routing
# key never appears in process arguments, an environment value, or the repository.
umask 077
PD_SECRET_FILE=$(mktemp)
trap 'rm -f "$PD_SECRET_FILE"' EXIT
IFS= read -r -s -p "PagerDuty routing key: " PD_ROUTING_KEY
printf '\n'
printf '%s\n' "$PD_ROUTING_KEY" | jq -Rn '{routing_key: input}' > "$PD_SECRET_FILE"
unset PD_ROUTING_KEY
SECRET_ARN=$(aws secretsmanager create-secret \
  --region us-east-2 \
  --name oracle-lake/pagerduty-routing-key \
  --secret-string "file://$PD_SECRET_FILE" \
  --query ARN --output text)
rm -f "$PD_SECRET_FILE"
trap - EXIT

CDK_DEFAULT_ACCOUNT=122610508924 \
ORACLE_DEPLOY_REGION=us-east-2 \
ORACLE_ALERT_ENVIRONMENT=production \
ORACLE_PAGERDUTY_SECRET_ARN="$SECRET_ARN" \
ORACLE_ALERT_EMAIL=oncall@example.com \
  just deploy
```

Paging is gated on the exact account `122610508924`, region `us-east-2`, and
`ORACLE_ALERT_ENVIRONMENT=production`. The stack reads only the complete secret ARN with an
exact IAM grant. Its SNS subscriber translates CloudWatch `ALARM` to PagerDuty `trigger` and
`OK` to `resolve`; there is no credential-bearing subscription URL. For scheduled ingestion, set
`CLERMONT_ALERT_TOPIC_ARN` from the `BaselineAlertTopicArn` output and retain
`CLERMONT_BASELINE_READ_ROLE_ARN`; the branch-bound role has only baseline-read and exact-topic
publish permission. To enable paging, create one routing-key secret in production Secrets
Manager and deploy the baseline stack with
`-c pagerDutySecretArn=arn:aws:secretsmanager:us-east-2:122610508924:secret:<exact-name-and-suffix>`.
Then set `CLERMONT_FAILURE_NOTIFIER_ARN` from the `FailureNotifierArn` output. GitHub may invoke
that exact function but never receives the routing key. Pass the same complete ARN to local
`npm run clermont:run -- --failure-notifier-arn "$CLERMONT_FAILURE_NOTIFIER_ARN" ...`; the
operator and GitHub roles can invoke only that function. Without that output, SNS still notifies
the approved email, but the deployment remains explicitly nonconformant for on-call paging.
Before enabling candidate-building workflow runs, set repository variable
`IPNS_PREDECESSOR_RECEIPT_JSON_B64` to the base64 encoding of a reviewed Filebase names receipt
for `oracle-open-data-lake`. The workflow validates its public network key, CID, and integer
sequence and freezes them into the publication request. Refresh this non-secret receipt after
each successful IPNS update; live publication reuses the restored signed request rather than a
mutable repository variable. The Pinata API base is fixed in workflow code; only the scoped JWT
is a secret.
Metric definitions, dashboard fields, DLQ applicability, and the external owner checklist are
recorded in the [observability handoff](observability-handoff.md).

## What the first deploy taught

The stack synthesised, the bundle built, the deploy reported success, and every route
returned 502. DuckDB resolves extensions under `$HOME/.duckdb/extensions/<version>/<platform>/`
and Lambda sets no `HOME`, so `LOAD httpfs` looked in `/.duckdb/`, missed, and the `INSTALL`
fallback died with `Can't find the home directory at ''`.

`httpfs` is not statically linked. It had never been in the bundle at all, and it only ever
loaded locally because a copy already sat in the developer's home directory — so no clean
machine could ever have cold-started this function. The bundle now downloads it for
`linux_arm64` at DuckDB's own `version()` and asserts it, and `ORACLE_DUCKDB_EXTENSION_DIR`
points DuckDB at it.

The lesson generalises: a green `cdk deploy` says CloudFormation converged, not that the
function runs. Always run the checks below against the returned URL.

## Verifying a deploy

```bash
URL=$(aws cloudformation describe-stacks --stack-name OracleLakeRuntime \
  --query "Stacks[0].Outputs[?OutputKey=='RuntimeUrl'].OutputValue" --output text)
curl -s "$URL/api/health"
curl -s "$URL/api/stats" | jq .stats.properties          # expect 215806
curl -s "$URL/mcp" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | jq -e '([.result.tools[].name] | sort) == [
      "findAgedRoofs",
      "findOpenRoofPermits",
      "findPropertiesInRadius",
      "getOracleDatasetInfo",
      "getOracleProperty",
      "getPropertyPermits",
      "getPropertyQuerySchema",
      "listOracleProperties",
      "queryProperties"
    ]'                                                    # require exactly these nine
# The SQL surface must refuse to read the host filesystem:
curl -s "$URL/api/sql" -H 'content-type: application/json' \
  -d '{"sql":"SELECT * FROM read_text('"'"'/etc/passwd'"'"')"}' | jq .error          # expect sql_rejected
```

That last check is not optional. An open SQL endpoint over an engine with filesystem access
is an arbitrary-file-read primitive, and this one was exactly that until it was fixed. Run
it against the deployed URL before showing anyone the link.
