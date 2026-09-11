/**
 * Ask: natural-language questions answered with citations.
 *
 * The answer is only half the point; the citations are the other half. Each one
 * names the tool that produced the evidence, the upstream systems behind it,
 * how many rows it saw, the parcels the claim rests on (clickable, so a reader
 * can go and check), and the exact SQL.
 *
 * Chat is the one capability that needs the server: it holds the model key. If
 * `OPENAI_API_KEY` is unset the server answers HTTP 503 `chat_unavailable`,
 * and this view says so calmly instead of failing.
 */

import { useRef, useState } from "react";
import {
  SOURCE_SYSTEM_LABELS,
  type ChatCitation,
  type ChatDocument,
  type ChatResponse,
} from "@oracle-lake/shared";
import { Badge, ErrorPanel, Panel } from "../components/Primitives.js";
import { useDataSource } from "../data/DataSourceProvider.js";
import { errorText, postJson } from "../data/http.js";
import { navigate, propertyPath } from "../hooks/useHashRoute.js";
import { formatCount } from "../lib/format.js";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  citations?: ChatCitation[];
  documents?: ChatDocument[];
  model?: string;
}

const EXAMPLES: readonly string[] = [
  "How many single-family homes have roofs 20 years or older in Clermont?",
  "Which parcels have roofing permits still open more than five years?",
  "Do out-of-state owners cluster in any city?",
  "What is the median market value of parcels with a TPP business account?",
];

export function AskView(): JSX.Element {
  const { meta, mode } = useDataSource();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; detail: string | null } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const send = async (text: string): Promise<void> => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || busy) return;
    const outgoing: ChatMessage[] = [...messages, { role: "user", content: trimmed }];
    setMessages(outgoing);
    setDraft("");
    setBusy(true);
    setError(null);
    try {
      const response = await postJson<ChatResponse>("/api/chat", {
        messages: outgoing.map((message) => ({ role: message.role, content: message.content })),
      });
      setMessages([
        ...outgoing,
        {
          role: "assistant",
          content: response.answer,
          citations: response.citations,
          documents: response.documents,
          model: response.model,
        },
      ]);
    } catch (thrown) {
      setError(errorText(thrown));
    } finally {
      setBusy(false);
    }
  };

  const unavailable = error?.message === "chat_unavailable" || meta?.chatEnabled === false;

  return (
    <div className="stack">
      {unavailable ? (
        <div className="notice" role="status">
          <h3>Ask is not configured on this server</h3>
          <p>
            {error?.detail ??
              "The server has no OPENAI_API_KEY, so it will not answer natural-language questions."}
          </p>
          <p>
            Every other view still works against the real published data. The Search, Tenant,
            Business and Contractor tabs, and the SQL console, all query the same table this view
            would have cited.
          </p>
        </div>
      ) : null}

      {mode === "browser" ? (
        <div className="notice info">
          <span className="micro">note</span>
          <p style={{ marginTop: 6 }}>
            Ask always runs on the server, because the model key lives there. Every other view on
            this page is being answered inside your browser from the published Parquet.
          </p>
        </div>
      ) : null}

      <Panel
        title="Ask the published table"
        subtitle="Answers are grounded in tool calls against the same run every other view queries."
      >
        <div className="chat-log">
          {messages.length === 0 ? (
            <div className="stack-sm">
              <span className="micro">try one of these</span>
              <div className="example-row">
                {EXAMPLES.map((example) => (
                  <button
                    key={example}
                    type="button"
                    className="example-btn"
                    onClick={() => void send(example)}
                    disabled={busy}
                  >
                    {example}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {messages.map((message, index) => (
            <article className={`message ${message.role}`} key={index}>
              <span className="micro">
                {message.role === "user"
                  ? "you"
                  : `assistant${message.model ? ` · ${message.model}` : ""}`}
              </span>
              <div className="message-body" style={{ marginTop: 6 }}>
                {message.content}
              </div>
              {message.citations && message.citations.length > 0 ? (
                <div style={{ marginTop: 10 }}>
                  <span className="micro">citations</span>
                  {message.citations.map((citation, citationIndex) => (
                    <Citation key={citationIndex} citation={citation} />
                  ))}
                </div>
              ) : null}
              {message.documents && message.documents.length > 0 ? (
                <div style={{ marginTop: 10 }}>
                  <span className="micro">sources read ({message.documents.length})</span>
                  {message.documents.map((document, documentIndex) => (
                    <RetrievedDocument key={documentIndex} document={document} />
                  ))}
                </div>
              ) : null}
            </article>
          ))}

          {busy ? (
            <div className="message">
              <span className="micro">assistant</span>
              <div style={{ marginTop: 8 }}>
                <div className="progress-line" />
              </div>
            </div>
          ) : null}
        </div>

        {error && !unavailable ? <ErrorPanel error={error} /> : null}

        <div className="composer">
          <label htmlFor="chat-input" className="micro">
            Your question
          </label>
          <textarea
            id="chat-input"
            ref={textareaRef}
            rows={3}
            value={draft}
            placeholder="Ask about parcels, roofs, permits, owners or business accounts…"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void send(draft);
              }
            }}
          />
          <div className="composer-foot">
            <span className="dim" style={{ fontSize: 11.5 }}>
              Cmd/Ctrl + Enter to send
            </span>
            <div className="row">
              {messages.length > 0 ? (
                <button
                  type="button"
                  className="btn small ghost"
                  onClick={() => {
                    setMessages([]);
                    setError(null);
                  }}
                  disabled={busy}
                >
                  Clear
                </button>
              ) : null}
              <button
                type="button"
                className="btn primary"
                onClick={() => void send(draft)}
                disabled={busy || draft.trim().length === 0}
              >
                {busy ? "Thinking…" : "Send"}
              </button>
            </div>
          </div>
        </div>
      </Panel>
    </div>
  );
}

/** One piece of evidence behind an answer. */
/**
 * One document retrieval surfaced for the answer.
 *
 * The agent returned these from the first turn and nothing rendered them, so an
 * answer grounded in the documentation showed no sign of what it had read. A
 * chunk drawn from a published artifact carries a CID, and that is shown as a
 * resolvable gateway link: the reader can fetch the exact bytes the claim rests
 * on without trusting this app.
 */
function RetrievedDocument({ document }: { document: ChatDocument }): JSX.Element {
  return (
    <div className="citation">
      <div className="citation-head">
        <Badge tone="accent" mono title={`Retrieval score ${document.score}`}>
          {document.score.toFixed(3)}
        </Badge>
        <Badge>{document.docType}</Badge>
        <span className="dim" style={{ fontSize: 11.5 }}>
          {document.title}
        </span>
      </div>
      <div className="chip-row">
        <Badge mono title={document.sourceFile}>
          {document.sourceFile}
        </Badge>
        {document.cid ? (
          <a
            className="parcel-chip"
            href={`https://ipfs.filebase.io/ipfs/${document.cid}`}
            target="_blank"
            rel="noreferrer"
            title={document.ipfsPath ?? document.cid}
          >
            {`${document.artifact ?? "artifact"} · ${document.cid.slice(0, 12)}…`}
          </a>
        ) : null}
      </div>
    </div>
  );
}

function Citation({ citation }: { citation: ChatCitation }): JSX.Element {
  return (
    <div className="citation">
      <div className="citation-head">
        <Badge tone="accent" mono>
          {citation.tool}
        </Badge>
        <span className="dim" style={{ fontSize: 11.5 }}>
          {formatCount(citation.rowCount)} row(s)
        </span>
        {citation.rootCid ? (
          <a
            className="parcel-chip"
            href={`https://ipfs.filebase.io/ipfs/${citation.rootCid}/query-table.parquet`}
            target="_blank"
            rel="noreferrer"
            title={`Run ${citation.runId ?? "?"} · ${citation.rootCid}`}
          >
            {`${citation.rootCid.slice(0, 10)}…`}
          </a>
        ) : null}
        {citation.sourceSystems.map((token) => (
          <Badge key={token} title={token}>
            {SOURCE_SYSTEM_LABELS[token] ?? token}
          </Badge>
        ))}
      </div>

      {citation.parcelIds.length > 0 ? (
        <div className="chip-row" style={{ marginBottom: 8 }}>
          {citation.parcelIds.map((parcelId) => (
            <button
              key={parcelId}
              type="button"
              className="parcel-chip"
              onClick={() => navigate(propertyPath(parcelId))}
            >
              {parcelId}
            </button>
          ))}
        </div>
      ) : null}

      {citation.sql ? (
        <details className="sql-block">
          <summary>SQL this citation ran</summary>
          <pre>
            <code>{citation.sql}</code>
          </pre>
        </details>
      ) : null}
    </div>
  );
}
