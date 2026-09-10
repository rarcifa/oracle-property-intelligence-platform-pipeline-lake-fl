/**
 * Plain-English search, on the page a reader looks for it.
 *
 * `/api/search` has always returned both halves — the corpus chunks that explain
 * the dataset, and the parcels a constrained question resolves to — but nothing
 * in the UI called it. The semantic surface existed only over curl and inside
 * Ask, so anyone told "semantic retrieval is under Search" went to this page and
 * concluded it did not exist.
 *
 * Server-only by nature: retrieval runs against the committed index, which the
 * browser DuckDB path has no access to. It needs no model key, which is the
 * point — a reviewer with no credentials can still see retrieval work.
 */

import { useState } from "react";
import { Badge, ErrorPanel, Panel } from "../components/Primitives.js";
import { postJson, errorText } from "../data/http.js";
import { formatCount } from "../lib/format.js";
import { navigate, propertyPath } from "../hooks/useHashRoute.js";

interface Chunk {
  id: string;
  docId: string;
  docType: string;
  title: string;
  score: number;
  text: string;
  provenance?: { sourceFile?: string; cid?: string | null };
}

interface ParcelHalf {
  interpretation?: { filter: string; value: unknown; phrase: string }[];
  filters?: Record<string, unknown>;
  matched?: number;
  rows?: Record<string, unknown>[];
  declined?: string;
}

interface SearchResponse {
  query: string;
  confidence: string;
  abstained: boolean;
  note?: string | null;
  chunks: Chunk[];
  parcels: ParcelHalf | null;
}

const EXAMPLES = [
  "aged roofs with an open roofing permit in Clermont",
  "why is contractor_name empty",
  "roofing permits still open more than five years",
  "what does the permit window actually cover",
];

export function SemanticSearchPanel({
  onFilters,
}: {
  /**
   * Hand the resolved filters to the page so the grid below shows the same
   * query. Without this the panel said "0 matching parcels" directly above a
   * grid saying 215,806, and neither number was wrong — they were answering
   * different questions, which is worse than either being wrong alone.
   */
  onFilters?: (filters: Record<string, unknown>) => void;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; detail: string | null } | null>(null);

  const run = async (text: string): Promise<void> => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || busy) return;
    setQuery(trimmed);
    setBusy(true);
    setError(null);
    try {
      const response = await postJson<SearchResponse>("/api/search", { query: trimmed, topK: 5 });
      setResult(response);
      if (response.parcels?.filters && Object.keys(response.parcels.filters).length > 0) {
        onFilters?.(response.parcels.filters);
      }
    } catch (thrown) {
      setError(errorText(thrown));
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  const parcels = result?.parcels ?? null;

  return (
    <Panel
      title="Ask in plain English"
      subtitle="Retrieval over the parcels and over the documentation about them. Runs on the server against the committed index and needs no model key — the filters on the left compile to exact SQL instead."
    >
      <div className="row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        {EXAMPLES.map((example) => (
          <button
            key={example}
            type="button"
            className="btn small ghost"
            // These labels are whole questions, so they must wrap rather than
            // push the row past the viewport. The responsive-design suite caught
            // exactly that at 320 px before this was added.
            style={{ whiteSpace: "normal", textAlign: "left", maxWidth: "100%" }}
            onClick={() => void run(example)}
            disabled={busy}
          >
            {example}
          </button>
        ))}
      </div>

      <div className="row" style={{ gap: 8 }}>
        <input
          type="text"
          aria-label="Search in plain English"
          className="text-input"
          style={{ flex: 1 }}
          value={query}
          placeholder="e.g. aged roofs with an open roofing permit in Clermont"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void run(query);
          }}
        />
        <button type="button" className="btn" onClick={() => void run(query)} disabled={busy}>
          {busy ? "Searching…" : "Search"}
        </button>
      </div>

      {error ? (
        <div style={{ marginTop: 12 }}>
          <ErrorPanel error={error} />
        </div>
      ) : null}

      {result ? (
        <div style={{ marginTop: 14 }}>
          <div className="row" style={{ gap: 8, marginBottom: 10 }}>
            <Badge tone={result.abstained ? "warn" : "accent"}>
              {result.abstained ? "abstained" : `confidence ${result.confidence}`}
            </Badge>
            {parcels?.matched !== undefined ? (
              <Badge>{formatCount(parcels.matched)} matching parcels</Badge>
            ) : null}
            <Badge>{result.chunks.length} documents</Badge>
          </div>

          {result.note ? (
            <p className="dim" style={{ marginTop: 0, fontSize: 12.5 }}>
              {result.note}
            </p>
          ) : null}

          {parcels?.declined ? (
            <p className="dim" style={{ fontSize: 12.5 }}>
              <strong>No parcel results: </strong>
              {parcels.declined}
            </p>
          ) : null}

          {parcels?.interpretation && parcels.interpretation.length > 0 ? (
            <div style={{ marginBottom: 12 }}>
              <span className="micro">how the question was read</span>
              <div className="chip-row" style={{ marginTop: 6 }}>
                {parcels.interpretation.map((entry) => (
                  <Badge key={entry.filter} mono title={`from “${entry.phrase}”`}>
                    {`${entry.filter} = ${String(entry.value)}`}
                  </Badge>
                ))}
              </div>
            </div>
          ) : null}

          {parcels?.rows && parcels.rows.length > 0 ? (
            <div style={{ marginBottom: 14 }}>
              <span className="micro">parcels</span>
              <div className="chip-row" style={{ marginTop: 6 }}>
                {parcels.rows.slice(0, 12).map((row) => (
                  <button
                    key={String(row.parcel_identifier)}
                    type="button"
                    className="parcel-chip"
                    onClick={() => navigate(propertyPath(String(row.parcel_identifier)))}
                  >
                    {String(row.address_street ?? row.parcel_identifier)}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <span className="micro">sources read</span>
          {result.chunks.map((chunk) => (
            <div className="citation" key={chunk.id}>
              <div className="citation-head">
                <Badge tone="accent" mono>
                  {chunk.score.toFixed(3)}
                </Badge>
                <Badge>{chunk.docType}</Badge>
                <span className="dim" style={{ fontSize: 11.5 }}>
                  {chunk.title}
                </span>
              </div>
              {chunk.provenance?.sourceFile ? (
                <div className="chip-row">
                  <Badge mono title={chunk.provenance.sourceFile}>
                    {chunk.provenance.sourceFile}
                  </Badge>
                  {chunk.provenance.cid ? (
                    <a
                      className="parcel-chip"
                      href={`https://ipfs.filebase.io/ipfs/${chunk.provenance.cid}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {`${chunk.provenance.cid.slice(0, 12)}…`}
                    </a>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </Panel>
  );
}
