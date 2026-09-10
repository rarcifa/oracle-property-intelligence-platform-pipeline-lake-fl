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
bundle exceeds Lambda's 250 MB unzipped limit. It currently comes to 89 MB.

## The chat key

The agent returns a clear 503 without a key rather than failing at boot.

Do **not** set `ANTHROPIC_API_KEY` on the function directly. That was tried, worked, and was
silently wrong: the stack declares `environment` in full, so the next `cdk deploy` drops the
key and the agent goes dark with nothing failing loudly. The key lives in Secrets Manager
and CloudFormation resolves it at deploy time, so it survives every redeploy and neither the
repository nor the synthesised template ever holds the value.

```bash
printf '%s' "$ANTHROPIC_API_KEY" > /tmp/key && \
  aws secretsmanager create-secret --name oracle-lake/anthropic-api-key \
    --secret-string file:///tmp/key && rm -f /tmp/key
```

Deploy without the agent by setting `ORACLE_ANTHROPIC_SECRET_NAME=""`.

## Pointing at a different published run

The function reads `ORACLE_PARQUET_URL`, which defaults to the newest published run root.
Republishing does not require a redeploy; repoint that variable, or leave it on the IPNS
path so it follows the pointer.

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
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools|length'   # expect 8
# The SQL surface must refuse to read the host filesystem:
curl -s "$URL/api/sql" -H 'content-type: application/json' \
  -d '{"sql":"SELECT * FROM read_text('"'"'/etc/passwd'"'"')"}' | jq .error          # expect sql_rejected
```

That last check is not optional. An open SQL endpoint over an engine with filesystem access
is an arbitrary-file-read primitive, and this one was exactly that until it was fixed. Run
it against the deployed URL before showing anyone the link.
