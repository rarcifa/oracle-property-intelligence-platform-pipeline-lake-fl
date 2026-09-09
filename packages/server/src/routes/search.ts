/**
 * `POST /api/search` — semantic retrieval over the Lake County corpus.
 *
 * Deliberately independent of the model key. The natural-language agent is the
 * nicer surface, but retrieval itself is a data capability, and a reviewer with
 * no `ANTHROPIC_API_KEY` must still be able to see that it works. Every hit
 * comes back with its score, its score's component signals, and the provenance
 * of the text — repository path, published artifact and CID.
 *
 * A question the corpus cannot answer returns HTTP 200 with `abstained: true`
 * and an explanation, not a 404 and not the nearest irrelevant chunk.
 */

import type { AppContext } from "../context.js";
import {
  RetrievalUnavailableError,
  getRetrievalIndex,
  searchCorpus,
  searchRequestSchema,
} from "../chat/retrieval.js";
import { fail, json, type Router } from "../http/router.js";

/** Register the retrieval routes. */
export function registerSearchRoutes(router: Router, _context: AppContext): void {
  router.get("/api/search", () => {
    try {
      const index = getRetrievalIndex();
      const byType = new Map<string, number>();
      const documents = new Set<string>();
      for (const chunk of index.raw.chunks) {
        byType.set(chunk.docType, (byType.get(chunk.docType) ?? 0) + 1);
        documents.add(chunk.docId);
      }
      return json(200, {
        usage: 'POST {"query": "why is contractor_name empty", "topK": 5} to this URL.',
        requiresModelKey: false,
        county: index.raw.county,
        builtFrom: index.raw.builtFrom,
        embedding: index.raw.embedding,
        chunks: index.raw.chunks.length,
        documents: documents.size,
        links: index.raw.links.length,
        chunksByDocType: Object.fromEntries([...byType.entries()].sort()),
      });
    } catch (error) {
      if (error instanceof RetrievalUnavailableError) {
        return fail(503, "retrieval_unavailable", error.detail);
      }
      throw error;
    }
  });

  router.post("/api/search", (request) => {
    const parsed = searchRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return fail(
        400,
        "invalid_body",
        parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
      );
    }
    try {
      return json(200, searchCorpus(parsed.data));
    } catch (error) {
      if (error instanceof RetrievalUnavailableError) {
        return fail(503, "retrieval_unavailable", error.detail);
      }
      return fail(500, "search_failed", error instanceof Error ? error.message : String(error));
    }
  });
}
