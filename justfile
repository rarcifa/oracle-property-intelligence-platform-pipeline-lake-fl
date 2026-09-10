# Recipe contract required by the kit's `integrate-ci-cd` skill: setup, format,
# lint, type-check, test, build, deploy. The shared reusable workflows that
# skill calls live in an external organisation this repository is not a member
# of, so `.github/workflows/ci.yml` runs these same recipes directly. Keeping
# the recipe names identical means moving to the shared pipeline later is a
# change of caller, not of contract.

set dotenv-load := false

# Install dependencies for the application and the ingestion runtime
setup:
    pnpm install --frozen-lockfile
    cd .claude/skills/use-oracle/runtime && npm ci

# Check code formatting
format:
    npx prettier --check .

# Run linting.
#
# Two passes, because one cannot cover both. `eslint .` ignores `.claude/**` so
# the vendored kit stays byte-identical to upstream, and ESLint prunes an ignored
# directory before an un-ignore can fire — so a negation there silently lints
# nothing. The second pass names the county files we wrote explicitly and forces
# them in with `--no-ignore`. CI runs this recipe, so both passes gate a merge.
lint:
    npx eslint .
    pnpm run lint:county

# Run type checking. Delegates to the per-package tsconfigs through turbo:
# the base config has no JSX setting, so pointing tsc at it directly fails on
# every React file in the UI package.
type-check:
    pnpm run typecheck

# Run the application tests and the ingestion runtime tests.
#
# Four runtime tests are excluded by name, in two pairs, and none of them is
# excluded because it found a defect.
#
# `no-oracle-node-runtime` and `mcp-json-parity` assert where the kit is checked
# out: the first requires the directory to be named `soofi-xyz-team-kit`, the
# second expects `.claude/mcp.json` where this repository keeps `.mcp.json` at
# its root.
#
# `published-county-catalog` and `print-mcp-env-maps` assert that the catalog
# holds exactly thirteen counties. Registering Lake through the kit's own
# sanctioned `catalog:update` makes it fourteen, so these fail *because* the
# registration succeeded. Any county added to this kit would break them.
#
# All four are excluded rather than edited, because the kit is vendored
# unmodified and `.claude/KIT_VERSION` must keep matching upstream exactly.
test:
    pnpm run test
    cd .claude/skills/use-oracle/runtime && npx vitest run \
        --exclude '**/tests/catalog/no-oracle-node-runtime.test.mjs' \
        --exclude '**/tests/catalog/mcp-json-parity.test.mjs' \
        --exclude '**/tests/catalog/published-county-catalog.test.mjs' \
        --exclude '**/tests/catalog/print-mcp-env-maps.test.mjs'
    cd .claude/skills/use-oracle/runtime && npm run test:transforms

# Build every package
build:
    pnpm run build

# Assemble the Lambda deployment bundle from the built packages
bundle: build
    node infra/scripts/build-lambda-bundle.mjs

# Deploy the hosted runtime. Needs AWS credentials; needs no Docker.
deploy: bundle
    cd infra && npx cdk deploy --require-approval never

# Synthesise the stack without deploying, to check it before a real deploy
synth: bundle
    cd infra && npx cdk synth --quiet

# Validate the county source catalog against the fail-closed readiness gate
readiness:
    python3 .claude/skills/use-oracle/scripts/validate-county-readiness.py \
        .claude/skills/use-oracle/runtime/docs/lake-sources.yaml
