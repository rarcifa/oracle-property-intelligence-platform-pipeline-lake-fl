/**
 * `/api/search` route tests.
 *
 * These run without DuckDB and without a model key, which is the point: the
 * retrieval surface is demonstrable on its own. The router is built from the
 * search routes alone so the suite does not depend on a published Parquet
 * being present in the checkout.
 */

import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createContext } from "../src/context.js";
import { OracleDataStore } from "../src/data/duckdb.js";
import { Router, type HttpResponse } from "../src/http/router.js";
import { registerSearchRoutes } from "../src/routes/search.js";
import { resetRetrievalIndex, toDocumentCitations } from "../src/chat/retrieval.js";
import { retrieve, loadIndex } from "@oracle-lake/rag";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface SearchBody {
  query: string;
  confidence: string;
  abstained: boolean;
  note: string;
  queryGrounding: number;
  unknownTerms: string[];
  chunks: {
    id: string;
    docId: string;
    docType: string;
    title: string;
    text: string;
    score: number;
    signals: Record<string, number>;
    provenance: {
      sourceFile: string;
      artifact: string | null;
      cid: string | null;
      ipfsPath: string | null;
    };
  }[];
  index: { chunkCount: number; runId: string | null; embeddingModel: string };
}

function buildRouter(): Router {
  // The config carries no model key and the store is never opened: retrieval
  // depends on neither.
  const config = loadConfig({
    ...process.env,
    OPENAI_API_KEY: "",
    ORACLE_DATA_RUN_ID: "",
    ORACLE_DATA_ROOT_CID: "",
    ORACLE_PARQUET_PATH: "",
    ORACLE_PARQUET_URL: "",
  });
  const store = new OracleDataStore({ source: "/tmp/never-opened.parquet" });
  const router = new Router();
  registerSearchRoutes(router, createContext(config, store));
  return router;
}

async function call(method: string, path: string, body?: unknown): Promise<HttpResponse> {
  const url = new URL(path, "http://test.local");
  return buildRouter().handle({
    method,
    path: url.pathname,
    query: url.searchParams,
    headers: { "content-type": "application/json" },
    body,
  });
}

function json<T>(response: HttpResponse): T {
  return JSON.parse(
    typeof response.body === "string" ? response.body : Buffer.from(response.body).toString("utf8"),
  ) as T;
}

describe("GET /api/search", () => {
  it("describes the index without needing a model key", async () => {
    resetRetrievalIndex();
    const response = await call("GET", "/api/search");
    expect(response.status).toBe(200);
    const body = json<{
      requiresModelKey: boolean;
      chunks: number;
      documents: number;
      embedding: { model: string; dimension: number };
      chunksByDocType: Record<string, number>;
    }>(response);
    expect(body.requiresModelKey).toBe(false);
    expect(body.chunks).toBeGreaterThan(100);
    expect(body.documents).toBeGreaterThan(90);
    expect(body.embedding.model).toBe("lsa-tfidf-svd");
    expect(body.chunksByDocType.column).toBe(85);
    expect(body.chunksByDocType.jurisdiction).toBe(16);
  });
});

describe("POST /api/search", () => {
  it("returns ranked chunks with scores and provenance", async () => {
    const response = await call("POST", "/api/search", { query: "why is contractor_name empty" });
    expect(response.status).toBe(200);
    const body = json<SearchBody>(response);
    expect(body.abstained).toBe(false);
    expect(body.confidence).toBe("high");
    expect(body.chunks[0]?.docId).toBe("column:contractor_name");
    expect(body.chunks[0]?.score).toBeGreaterThan(0.4);
    expect(body.chunks[0]?.signals.lexical).toBeGreaterThan(0);
    expect(body.chunks[0]?.provenance.sourceFile.length).toBeGreaterThan(0);
    expect(body.index.embeddingModel).toBe("lsa-tfidf-svd");
  });

  it("labels candidate artifact chunks without borrowing a published CID", async () => {
    const response = await call("POST", "/api/search", {
      query: "what documented limitations does the coverage snapshot record",
      topK: 5,
    });
    const body = json<SearchBody>(response);
    const artifacts = body.chunks.filter((chunk) => chunk.provenance.artifact !== null);
    expect(artifacts.length).toBeGreaterThan(0);
    expect(artifacts[0]?.provenance.ipfsPath).toBeNull();
  });

  it("honours topK", async () => {
    const response = await call("POST", "/api/search", { query: "permit jurisdiction", topK: 3 });
    expect(json<SearchBody>(response).chunks.length).toBeLessThanOrEqual(3);
  });

  it("abstains with an explanation rather than returning the nearest chunk", async () => {
    const response = await call("POST", "/api/search", {
      query: "give me a recipe for key lime pie",
    });
    expect(response.status).toBe(200);
    const body = json<SearchBody>(response);
    expect(body.abstained).toBe(true);
    expect(body.chunks).toHaveLength(0);
    expect(body.note).toContain("No document");
    expect(body.unknownTerms.length).toBeGreaterThan(0);
  });

  it("rejects a malformed body with a field-level explanation", async () => {
    const response = await call("POST", "/api/search", { query: "a" });
    expect(response.status).toBe(400);
    expect(json<{ error: string; detail: string }>(response).error).toBe("invalid_body");
  });

  it("rejects a missing body", async () => {
    const response = await call("POST", "/api/search", undefined);
    expect(response.status).toBe(400);
  });

  it("answers 405 on an unsupported method", async () => {
    const response = await call("DELETE", "/api/search");
    expect(response.status).toBe(405);
  });
});

describe("document citations", () => {
  it("flatten a retrieval result into citable records", () => {
    const result = retrieve(
      { query: "how do I request permit records from Leesburg", topK: 3 },
      loadIndex(),
    );
    const citations = toDocumentCitations(result);
    expect(citations.length).toBeGreaterThan(0);
    expect(citations[0]?.docId).toBe("jurisdiction:leesburg");
    expect(citations[0]?.sourceFile).toContain("lake-sources.yaml");
    expect(citations[0]?.score).toBeGreaterThan(0);
  });
});

describe("agent wiring", () => {
  const agentSource = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/chat/agent.ts"),
    "utf8",
  );

  it("exposes retrieval to the model as a Zod-typed tool", () => {
    expect(agentSource).toContain("searchDocuments: tool({");
    expect(agentSource).toContain("inputSchema: z.object({");
    expect(agentSource).toContain("searchCorpus(");
  });

  it("instructs the model to cite retrieved documents and to honour an abstention", () => {
    expect(agentSource).toContain("Call searchDocuments for those");
    expect(agentSource).toContain("abstained: true");
    expect(agentSource).toContain("no document in the corpus answers that question");
  });

  it("returns document citations alongside the SQL citations", () => {
    expect(agentSource).toContain("interface ChatResponseWithDocuments extends ChatResponse");
    expect(agentSource).toContain("documents: collector.documents");
  });

  it("keeps the retrieval path free of `any`", () => {
    const retrievalSource = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../src/chat/retrieval.ts"),
      "utf8",
    );
    expect(retrievalSource).not.toMatch(/\bany\b\s*[;,)\]>]/);
    expect(agentSource).not.toMatch(/\bany\b\s*[;,)\]>]/);
  });
});
