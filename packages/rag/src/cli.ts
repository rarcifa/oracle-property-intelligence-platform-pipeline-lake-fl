#!/usr/bin/env node
/**
 * The query-only local RAG CLI.
 *
 * Normal output is JSON on stdout so an agent can parse it; diagnostics go to
 * stderr behind `RAG_DEBUG=true`, so stdout stays valid JSON in every mode.
 * `build` is the one command that writes: it regenerates the committed index
 * from the checkout.
 */

import { loadIndex, resetIndexCache } from "./index/load.js";
import { writeIndex, INDEX_PATH } from "./index/build-index.js";
import { retrieve, THRESHOLDS } from "./retrieve.js";
import { runEval } from "./eval/run-eval.js";
import { suggestPaths } from "./paths.js";
import { readFile } from "node:fs/promises";
import { promotePublishedCorpus } from "./promote.js";

const debug = process.env.RAG_DEBUG === "true";

function log(message: string): void {
  if (debug) process.stderr.write(`[rag] ${message}\n`);
}

function print(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

interface QueryArguments {
  text: string;
  topK: number;
}

async function parseQueryArguments(argv: string[]): Promise<QueryArguments> {
  let file: string | null = null;
  let topK = 5;
  const text: string[] = [];

  for (let position = 0; position < argv.length; position += 1) {
    const argument = argv[position] as string;
    if (argument === "--file") {
      file = argv[position + 1] ?? null;
      if (file === null) throw new Error("--file requires a path");
      position += 1;
      continue;
    }
    if (argument === "--top-k") {
      const value = argv[position + 1];
      if (value === undefined) throw new Error("--top-k requires an integer");
      topK = Number.parseInt(value, 10);
      if (!/^\d+$/.test(value) || !Number.isInteger(topK)) {
        throw new Error("--top-k requires an integer");
      }
      position += 1;
      continue;
    }
    if (argument.startsWith("--")) throw new Error(`Unknown option: ${argument}`);
    text.push(argument);
  }

  if (file !== null && text.length > 0) {
    throw new Error("Pass either positional text or --file, not both");
  }
  return { text: file === null ? text.join(" ") : await readFile(file, "utf8"), topK };
}

async function main(): Promise<number> {
  const [, , command = "help", ...rest] = process.argv;

  switch (command) {
    case "promote": {
      const values = new Map<string, string>();
      for (let position = 0; position < rest.length; position += 2) {
        const flag = rest[position];
        const value = rest[position + 1];
        if (!flag?.startsWith("--") || !value || value.startsWith("--")) {
          throw new Error("promote flags must be --name value pairs");
        }
        values.set(flag, value);
      }
      const runId = values.get("--run-id");
      const rootCid = values.get("--root-cid");
      if (!runId || !rootCid) {
        throw new Error("promote requires --run-id and --root-cid");
      }
      const result = await promotePublishedCorpus({
        runId,
        rootCid,
        latestPath: values.get("--latest"),
        manifestPath: values.get("--manifest"),
        verificationPath: values.get("--verification"),
        ledgerPath: values.get("--ledger"),
      });
      print({ command: "promote", runId, rootCid, ...result });
      return 0;
    }

    case "build": {
      const runIdPosition = rest.indexOf("--run-id");
      const runId = runIdPosition >= 0 ? rest[runIdPosition + 1] : undefined;
      if (!runId) {
        print({
          error: "missing_run_id",
          detail: "Pass --run-id matching the explicit corpus-source.json receipt.",
        });
        return 2;
      }
      const started = Date.now();
      const { path, index } = await writeIndex(INDEX_PATH, runId);
      log(`built ${index.chunks.length} chunks in ${Date.now() - started} ms`);
      print({
        command: "build",
        path,
        chunks: index.chunks.length,
        links: index.links.length,
        documents: new Set(index.chunks.map((chunk) => chunk.docId)).size,
        embedding: index.embedding,
        builtFrom: index.builtFrom,
        sourceSnapshot: index.sourceSnapshot,
      });
      return 0;
    }

    case "inspect": {
      const index = loadIndex();
      const byType = new Map<string, number>();
      const docs = new Set<string>();
      for (const chunk of index.raw.chunks) {
        byType.set(chunk.docType, (byType.get(chunk.docType) ?? 0) + 1);
        docs.add(chunk.docId);
      }
      print({
        command: "inspect",
        indexPath: INDEX_PATH,
        schemaVersion: index.raw.schemaVersion,
        county: index.raw.county,
        builtFrom: index.raw.builtFrom,
        sourceSnapshot: index.raw.sourceSnapshot,
        embedding: index.raw.embedding,
        chunks: index.raw.chunks.length,
        documents: docs.size,
        links: index.raw.links.length,
        vocabulary: index.termIndex.size,
        averageChunkTokens: Math.round(index.raw.lexical.averageLength),
        chunksByDocType: Object.fromEntries([...byType.entries()].sort()),
        thresholds: THRESHOLDS,
      });
      return 0;
    }

    case "query": {
      const { text, topK } = await parseQueryArguments(rest);
      if (text.trim().length === 0) {
        print({ error: "empty_query", detail: "Pass a query string or --file <path>." });
        return 2;
      }
      log(`query: ${text.trim().slice(0, 120)}`);
      const result = retrieve({ query: text.trim(), topK });
      log(
        `confidence=${result.confidence} considered=${result.consideredCount} kept=${result.chunks.length}`,
      );
      print(result);
      return 0;
    }

    case "paths": {
      const { text, topK } = await parseQueryArguments(rest);
      if (text.trim().length === 0) {
        print({ error: "empty_query", detail: "Pass acceptance criteria or --file <path>." });
        return 2;
      }
      log(`paths: ${text.trim().slice(0, 120)}`);
      const result = suggestPaths({ query: text.trim(), topK });
      log(`abstained=${result.abstained} suggestions=${result.suggestions.length}`);
      print({ command: "paths", ...result });
      return 0;
    }

    case "eval": {
      resetIndexCache();
      const report = runEval();
      log(`P@1=${report.positives.precisionAt1} abstention=${report.negatives.abstentionRate}`);
      print({ command: "eval", ...report });
      return report.negatives.falseHighConfidence.length === 0 ? 0 : 1;
    }

    default:
      print({
        command: "help",
        usage: [
          "pnpm --filter @oracle-lake/rag build:index",
          "pnpm --filter @oracle-lake/rag promote:published -- --run-id <run> --root-cid <cid>",
          'pnpm --filter @oracle-lake/rag query -- "why is contractor_name empty"',
          "pnpm --filter @oracle-lake/rag query -- --top-k 8 --file ./question.txt",
          'pnpm --filter @oracle-lake/rag paths -- "permit-grain contractor evidence"',
          "pnpm --filter @oracle-lake/rag paths -- --top-k 8 --file ./criteria.txt",
          "pnpm --filter @oracle-lake/rag inspect",
          "pnpm --filter @oracle-lake/rag eval",
        ],
        notes: [
          "stdout is always JSON; set RAG_DEBUG=true for stderr diagnostics.",
          "No API key is required by any command.",
        ],
      });
      return 0;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `[rag] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.stdout.write(`${JSON.stringify({ error: "cli_failed", detail: String(error) })}\n`);
    process.exitCode = 1;
  });
