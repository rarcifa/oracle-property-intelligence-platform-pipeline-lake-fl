# `@oracle-lake/rag`

Semantic retrieval over the Lake County, FL property-intelligence dataset's
documentation, source catalog and published run artifacts.

This is the **question-answering layer that is not SQL**. The agent in
`packages/server` writes SQL against a 215,806-row query table and answers "how
many" and "which parcels". It cannot answer "why is `contractor_name` empty",
"what does the CD Plus permit layer actually cover", "how was roof age derived"
or "which jurisdictions are blocked and how do I request their records" —
because none of those answers are rows. This package answers those, with
citations.

## Quick start

```bash
pnpm --filter @oracle-lake/rag inspect
pnpm --filter @oracle-lake/rag query -- "why is contractor_name empty"
pnpm --filter @oracle-lake/rag eval
```

Nothing here needs an API key, a model download or a network connection.

Over HTTP, with the server running:

```bash
curl -s localhost:8787/api/search | jq '{chunks, documents, embedding}'
curl -s localhost:8787/api/search -H 'content-type: application/json' \
  -d '{"query":"which jurisdictions are blocked and how do I request their records","topK":5}' \
  | jq '{confidence, abstained, hits: [.chunks[] | {docId, score, sourceFile: .provenance.sourceFile}]}'
```

## Why no embedding API

The requirement was a retrieval layer that works with **no paid API key at build
time and none at boot**. A hosted embedding model fails the second half: even
with document vectors cached, embedding the _query_ still needs the provider. A
local transformer fails it differently — it puts an ONNX runtime and ~90 MB of
weights in the server's boot path, on a deployment whose entire premise is no
ongoing infrastructure cost.

So the semantic component is **latent semantic indexing**: truncated SVD of the
corpus TF-IDF matrix, computed at build time and committed. A query folds into
the same latent space with one sparse multiply against the postings list the
lexical scorer already loads. Index load is ~40 ms; a query is ~2 ms.

That gives real dense-vector semantics with no provider, but it learns from this
corpus alone rather than from English at large. It is therefore one signal among
five, not the retriever:

| Signal        | What it contributes                                                              | Weight |
| ------------- | -------------------------------------------------------------------------------- | ------ |
| BM25 lexical  | refuses documents sharing no vocabulary — this is what makes abstention possible | 0.42   |
| Latent cosine | bridges vocabulary gaps within the corpus                                        | 0.24   |
| Entity alias  | deterministic whole-phrase match on column names, city names, source names       | 0.14   |
| Title match   | a document _about_ the subject beats forty that merely cite it                   | 0.12   |
| Exact phrase  | multi-word phrase present verbatim                                               | 0.08   |

Plus two rerank rules: a chunk matching nothing the user typed is multiplied by
0.3, and the whole result set is damped by `queryGrounding^1.5`, where grounding
is the fraction of typed words that exist anywhere in the corpus. That damper is
the single most effective out-of-domain detector here — "median household income"
and "key lime pie" each contain one word the corpus knows and several it does
not.

## Measured quality

25-question evaluation set (`src/eval/questions.ts`): 20 answerable questions
with expected documents, 5 unanswerable controls.

| Metric                                    | Value       |
| ----------------------------------------- | ----------- |
| Precision@1                               | **0.90**    |
| Hit rate @3                               | **1.00**    |
| Hit rate @5                               | **1.00**    |
| Mean reciprocal rank                      | **0.95**    |
| Normalised precision@3                    | 0.875       |
| Normalised precision@5                    | 0.888       |
| Strict precision@3 / @5                   | 0.50 / 0.31 |
| Abstention rate on unanswerable questions | **1.00**    |
| Unanswerable questions given any answer   | **0**       |

Strict precision divides by _k_, so a question with one relevant document can
never exceed 1/_k_; the normalised figures divide by the number of relevant
documents that could fit in _k_, which is the number worth calibrating against.
Both are reported because quoting only one would flatter the result.

Threshold calibration is tight: the best-scoring unanswerable question reaches
0.221 and the weakest answerable one reaches 0.299, with the floor at 0.23.
That margin is thin enough to be worth re-measuring whenever the corpus changes,
which `pnpm --filter @oracle-lake/rag eval` does in one command.

## Layout

```
src/text.ts              tokenizer, stemmer, hashing  — shared by build and query
src/aliases.ts           domain vocabulary expansion + entity alias scoring
src/corpus/markdown.ts   heading-aware chunking with stable ids
src/corpus/sources-yaml.ts  jurisdictions, sources, access states
src/corpus/columns.ts    one document per published column
src/corpus/artifacts.ts  coverage, limitations, publication, samples
src/corpus/build.ts      orchestration; pure function of the checkout
src/index/lsa.ts         TF-IDF, gram matrix, power-iteration SVD, query fold-in
src/index/bm25.ts        Okapi BM25 with absolute-scale saturation
src/index/build-index.ts writes the committed index
src/index/load.ts        validates and prepares it
src/retrieve.ts          the pipeline and the confidence policy
src/eval/                the evaluation set and its harness
src/cli.ts               inspect | query | eval | build
index-data/lake-rag-index.json   committed build output (744 KB)
```

Agent-facing usage instructions are in [`AGENTS.md`](AGENTS.md).
