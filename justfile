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
    cd pipeline && npm ci

# Check code formatting
format:
    npx prettier --check .

# Run linting.
#
# Two passes, because the root application and standalone ingestion runtime
# have different lint boundaries. The second pass names the Lake pipeline and
# publication files explicitly. CI runs this recipe, so both passes gate a merge.
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
# The runtime's catalog tests are part of the gate: the project owns this
# extracted pipeline and keeps its path and county-count assertions current.
test:
    pnpm run test
    npm test --prefix pipeline

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
    python3 pipeline/scripts/validate-county-readiness.py \
        pipeline/docs/lake-sources.yaml
