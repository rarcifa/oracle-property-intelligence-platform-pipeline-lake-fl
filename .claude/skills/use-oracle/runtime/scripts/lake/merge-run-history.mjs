#!/usr/bin/env node
/**
 * Merge a carried-over run history into the repository's copy.
 *
 * A scheduled ingestion run publishes from a fresh checkout and appends its run
 * to `artifacts/run-history.json`, then the runner is destroyed. Nothing carried
 * the file forward, so the next scheduled run started from the committed copy
 * again and every publish made between commits was absent from the record —
 * the history claimed to be append-only while silently losing entries.
 *
 * The workflow now caches the file between runs and merges the cached copy in
 * before publishing, so the record accumulates. The merge is a union that
 * refuses to alter any recorded run, which is the same guarantee the appender
 * makes. This extends `integrate-ci-cd`'s conventions rather than inventing a
 * new one: state that must survive a scheduled run is restored and saved with
 * the same `actions/cache` pair already used here for the row hashes and the
 * permit merge base.
 *
 * Usage:
 *   node scripts/lake/merge-run-history.mjs <target> <carried>
 *
 * @module scripts/lake/merge-run-history
 */

import { mergeRunHistoryFile } from "../../src/core/run-history.mjs";

const [target, carried] = process.argv.slice(2);
if (!target || !carried) {
  process.stderr.write("usage: merge-run-history.mjs <target-history> <carried-history>\n");
  process.exit(2);
}

mergeRunHistoryFile(target, carried)
  .then((history) => {
    process.stdout.write(
      `${JSON.stringify({ event: "run_history_merged", target, carried, runs: history.runs.length })}\n`,
    );
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
