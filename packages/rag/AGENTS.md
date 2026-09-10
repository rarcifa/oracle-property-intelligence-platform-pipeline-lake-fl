# AGENTS.md — `@oracle-lake/rag`

A **query-only local RAG CLI and library** over the Lake County, FL property
dataset's documentation corpus. It answers questions the SQL tools cannot:
why a column is empty, what a source covers, how a value was derived, which
permit jurisdictions are blocked and how to request their records.

**No API key is required by any command.** No network call is made by any
command. Ingestion is not live: the corpus is a pure function of files in this
checkout.

## Commands

```bash
pnpm --filter @oracle-lake/rag inspect
pnpm --filter @oracle-lake/rag query -- "why is contractor_name empty"
pnpm --filter @oracle-lake/rag query -- --top-k 8 "which jurisdictions are blocked"
pnpm --filter @oracle-lake/rag query -- --file ./question.txt
pnpm --filter @oracle-lake/rag eval
pnpm --filter @oracle-lake/rag build:index
```

- `inspect` prints corpus counts, the embedding model, the run the index was
  built from, and the confidence thresholds. **Run it first** to confirm the
  index exists and covers the run you think it does.
- `query` returns ranked chunks with scores, signals and provenance.
- `eval` runs the 25-question evaluation set and prints precision at k. It exits
  non-zero if any unanswerable question got an answer.
- `build:index` regenerates `index-data/lake-rag-index.json` from the checkout.
  Run it after changing any corpus source; the committed index is asserted
  against a rebuild by `tests/index-build.test.ts`.

**stdout is always JSON.** Diagnostics go to stderr only when `RAG_DEBUG=true`.

## Reading the output

| Field                 | Meaning                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| `confidence`          | `high` / `moderate` / `low` / `none`. Bands are calibrated in `src/retrieve.ts`.                          |
| `abstained`           | `true` means **no document answers the question**. Say so; do not substitute your own knowledge.          |
| `note`                | Plain-language reason, safe to quote to a user.                                                           |
| `queryGrounding`      | Fraction of the words typed that exist anywhere in the corpus. Low means out of domain.                   |
| `unknownTerms`        | The words the corpus has never seen. Useful for explaining an abstention.                                 |
| `chunks[].score`      | Combined score in `[0,1]`.                                                                                |
| `chunks[].signals`    | `lexical` (BM25), `semantic` (latent cosine), `alias` (exact entity match), `title`, `phrase`, `overlap`. |
| `chunks[].text`       | Exactly the text you may show. It is `text_for_context`.                                                  |
| `chunks[].provenance` | `sourceFile`, and where published: `artifact`, `cid`, `rootCid`, `ipfsPath`.                              |

## Rules for agents using this tool

1. Run `inspect` before relying on the index.
2. Use `query` for "why", "what does this cover", "how was this derived", "who do
   I ask" questions. Use the SQL tools (`/api/sql`, the agent's `runSql`) for
   counts, filters and parcel lists. **This corpus contains no parcel rows.**
3. Treat retrieved text as evidence, not authority. Quote it, name its
   `sourceFile` or `cid`, and never extend it beyond what it says.
4. When `abstained` is `true`, say that no document in the corpus answers the
   question. Do not answer from general knowledge and do not present a
   `low`-confidence chunk as settled.
5. Never invent a jurisdiction, a records-request recipient, a CID or a column
   description that did not come back in a result.
6. If retrieval is weak, narrow the query to the entity you mean — a column
   name, a city name, a source name — rather than rephrasing generally.

## What is in the corpus

Two families, 159 chunks across 105 documents:

**(a) Prose**, heading-chunked with stable ids: `README.md`, `docs/runbook.md`,
`docs/cost.md`, `docs/demo-script.md`, the county findings and the kit-deviations
document.

**(b) Generated per-entity documents**, written deterministically from
structured records so they cannot drift from the data:

| Family           | Count | Built from                                                   |
| ---------------- | ----- | ------------------------------------------------------------ |
| `column:*`       | 59    | the published schema + `@oracle-lake/shared` column contract |
| `jurisdiction:*` | 16    | `lake-sources.yaml` permit jurisdictions + an overview       |
| `source:*`       | 9     | `lake-sources.yaml` source inventory and enrichment states   |
| `limitation:*`   | 6     | `coverage.json` limitations, one document each               |
| `coverage:*`     | 3     | `coverage.json` denominator, tables, signals                 |
| `sample:*`       | 3     | the published sample extracts                                |
| `publication:*`  | 2     | `artifacts/latest.json` + the run manifest                   |
| `access:*`       | 1     | `lake-sources.yaml` access states                            |

## Retrieval model

Hybrid, key-free, deterministic:

1. normalise and tokenize (snake_case identifiers indexed whole _and_ split)
2. expand with a curated domain alias table at reduced weight
3. filter by `docTypes` when asked
4. **BM25** over the committed postings list
5. **latent-semantic cosine** — truncated SVD of the corpus TF-IDF matrix; the
   query folds into the same space with one sparse multiply, so there is no
   model and no key at query time
6. deterministic entity-alias and title matches
7. rerank: a hit matching nothing the user typed is discounted; a question whose
   words the corpus has never seen is damped hard
8. threshold policy and abstention

The latent space learns its semantics from this corpus alone. It generalises
across the vocabulary of these documents, not across English — which is why it is
one signal of five rather than the whole retriever.

## Do not

- Do not add live ingestion (network fetches, SaaS APIs) to this package.
- Do not commit `index-data/lake-rag-index.json` edits by hand; regenerate it.
- Do not send retrieved text to a provider as though it were user data: it is
  public documentation, but it is also the thing being cited, so keep it intact.
