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
import { readFile } from "node:fs/promises";

const debug = process.env.RAG_DEBUG === "true";

function log(message: string): void {
  if (debug) process.stderr.write(`[rag] ${message}\n`);
}

function print(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function flagValue(argv: string[], flag: string): string | null {
  const position = argv.indexOf(flag);
  return position >= 0 ? (argv[position + 1] ?? null) : null;
}

async function main(): Promise<number> {
  const [, , command = "help", ...rest] = process.argv;

  switch (command) {
    case "build": {
      const started = Date.now();
      const { path, index } = await writeIndex();
      log(`built ${index.chunks.length} chunks in ${Date.now() - started} ms`);
      print({
        command: "build",
        path,
        chunks: index.chunks.length,
        links: index.links.length,
        documents: new Set(index.chunks.map((chunk) => chunk.docId)).size,
        embedding: index.embedding,
        builtFrom: index.builtFrom,
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
      const fromFile = flagValue(rest, "--file");
      const topK = Number.parseInt(flagValue(rest, "--top-k") ?? "5", 10);
      const text = fromFile
        ? await readFile(fromFile, "utf8")
        : rest
            .filter(
              (argument) => !argument.startsWith("--") && argument !== flagValue(rest, "--top-k"),
            )
            .join(" ");
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
          'pnpm --filter @oracle-lake/rag query -- "why is contractor_name empty"',
          "pnpm --filter @oracle-lake/rag query -- --top-k 8 --file ./question.txt",
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
