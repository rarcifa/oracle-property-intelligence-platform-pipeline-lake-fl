/**
 * `POST /api/search` — semantic retrieval over the Lake County corpus.
 *
 * Deliberately independent of the model key. The natural-language agent is the
 * nicer surface, but retrieval itself is a data capability, and a reviewer with
 * no `OPENAI_API_KEY` must still be able to see that it works. Every hit
 * comes back with its score, its score's component signals, and the provenance
 * of the text — repository path, published artifact and CID.
 *
 * A question the corpus cannot answer returns HTTP 200 with `abstained: true`
 * and an explanation, not a 404 and not the nearest irrelevant chunk.
 */

import { interpretParcelQuery, type ParcelVocabulary } from "@oracle-lake/rag";
import { searchOptionsSchema } from "@oracle-lake/shared";
import type { AppContext } from "../context.js";
import { getFacets, searchProperties } from "../data/queries.js";
import {
  RetrievalUnavailableError,
  getRetrievalIndex,
  searchCorpus,
  searchRequestSchema,
} from "../chat/retrieval.js";
import { fail, json, type Router } from "../http/router.js";

/**
 * The roll's own city and property-type vocabulary, read once.
 *
 * A city is only matched if the published table actually contains it, so a
 * question about Orlando cannot silently become a filter that matches nothing.
 */
let vocabularyPromise: Promise<ParcelVocabulary> | null = null;

async function parcelVocabulary(context: AppContext): Promise<ParcelVocabulary> {
  vocabularyPromise ??= (async () => {
    const facets = await getFacets(context.store);
    return {
      cities: facets.cities.map((row) => String(row.value)).filter((value) => value.length > 0),
      propertyTypes: facets.propertyTypes
        .map((row) => String(row.value))
        .filter((value) => value.length > 0),
    };
  })().catch((error: unknown) => {
    // Never cache a rejection: a transient gateway failure must not disable
    // parcel retrieval for the life of the process.
    vocabularyPromise = null;
    throw error;
  });
  return vocabularyPromise;
}

/**
 * The parcel half of the answer, or `null`.
 *
 * Deliberately best-effort. Corpus retrieval needs no data table at all, and it
 * must keep working when the published Parquet is unreachable — a reviewer with
 * no network to the gateway should still see that retrieval works, which is the
 * whole reason this route does not require a model key either.
 */
async function parcelHalf(
  context: AppContext,
  query: string,
  topK: number,
): Promise<unknown | null> {
  try {
    const vocabulary = await parcelVocabulary(context);
    const interpreted = interpretParcelQuery(query, vocabulary);
    if (!interpreted.answersAboutParcels) {
      // Say why, when there is a reason. A declined negation is a different
      // answer from "this question is not about parcels", and a caller who is
      // told nothing will assume the second.
      return interpreted.declined === undefined
        ? null
        : { declined: interpreted.declined, interpretation: [], filters: {}, matched: 0, rows: [] };
    }

    const options = searchOptionsSchema.parse({
      ...interpreted.filters,
      limit: Math.min(topK, 25),
    });
    const provenance = await context.provenance();
    const result = await searchProperties(context.store, provenance, options);
    return {
      interpretation: interpreted.interpretation,
      filters: interpreted.filters,
      matched: result.matched,
      returned: result.rows.length,
      rows: result.rows,
      provenance: result.provenance,
    };
  } catch {
    return null;
  }
}

/** Register the retrieval routes. */
export function registerSearchRoutes(router: Router, context: AppContext): void {
  router.get("/api/search", async () => {
    try {
      const index = getRetrievalIndex();
      const provenance = await context.provenance();
      searchCorpus(
        { query: "Lake County corpus status", topK: 1 },
        { runId: provenance.runId, rootCid: provenance.rootCid },
      );
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

  router.post("/api/search", async (request) => {
    const parsed = searchRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return fail(
        400,
        "invalid_body",
        parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
      );
    }
    try {
      const provenance = await context.provenance();
      const corpus = searchCorpus(parsed.data, {
        runId: provenance.runId,
        rootCid: provenance.rootCid,
      });

      // Hybrid, and the second half is the point: retrieval used to cover the
      // dataset's metadata only, so a question about the 215,806 parcels
      // themselves had nothing to retrieve from. Constraints in the question are
      // resolved against the published table's own filter contract and run as
      // SQL, so the rows returned actually satisfy them — which a bag-of-words
      // score over a per-parcel text profile demonstrably did not.
      const parcels = await parcelHalf(context, parsed.data.query, parsed.data.topK ?? 5);
      return json(200, { ...corpus, parcels });
    } catch (error) {
      if (error instanceof RetrievalUnavailableError) {
        return fail(503, "retrieval_unavailable", error.detail);
      }
      return fail(500, "search_failed", error instanceof Error ? error.message : String(error));
    }
  });
}
