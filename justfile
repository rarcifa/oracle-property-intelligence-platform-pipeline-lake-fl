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

# Run linting
lint:
    npx eslint .

# Run type checking. Delegates to the per-package tsconfigs through turbo:
# the base config has no JSX setting, so pointing tsc at it directly fails on
# every React file in the UI package.
type-check:
    pnpm run typecheck

# Run the application tests and the ingestion runtime tests.
#
# Two runtime tests are excluded by name. Both assert where the kit is checked
# out rather than anything about this county: `no-oracle-node-runtime` requires
# the directory to be named `soofi-xyz-team-kit`, and `mcp-json-parity` expects
# `.claude/mcp.json` where this repository keeps `.mcp.json` at its root. They
# are excluded rather than edited, because the kit is vendored unmodified and
# `.claude/KIT_VERSION` must keep matching upstream exactly.
test:
    npx vitest run
    cd .claude/skills/use-oracle/runtime && npx vitest run \
        --exclude '**/tests/catalog/no-oracle-node-runtime.test.mjs' \
        --exclude '**/tests/catalog/mcp-json-parity.test.mjs'
    cd .claude/skills/use-oracle/runtime && npm run test:transforms

# Build every package
build:
    pnpm run build

# Deploy the hosted runtime, refusing rather than pretending when absent
deploy:
    @if [ ! -d infra ]; then \
        echo "No infra/ stack present. The hosted runtime has not been provisioned."; \
        echo "See docs/deploy.md. Refusing to report a successful deploy."; \
        exit 1; \
    fi
    cd infra && npx cdk deploy --require-approval never

# Validate the county source catalog against the fail-closed readiness gate
readiness:
    python3 .claude/skills/use-oracle/scripts/validate-county-readiness.py \
        .claude/skills/use-oracle/runtime/docs/lake-sources.yaml
