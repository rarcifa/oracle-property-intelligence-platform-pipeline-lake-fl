/**
 * Small presentational primitives shared by every view.
 *
 * They exist so that "loading" is always a skeleton (never a blank screen),
 * "error" always prints the server's own `error`/`detail` text, and a badge
 * always carries words as well as a colour.
 */

import type { ReactNode } from "react";

/** A shimmering block standing in for content that has not arrived. */
export function Skeleton({
  width = "100%",
  height = 14,
  radius = 6,
}: {
  width?: string | number;
  height?: string | number;
  radius?: number;
}): JSX.Element {
  return (
    <span
      className="skeleton"
      aria-hidden="true"
      style={{ display: "block", width, height, borderRadius: radius }}
    />
  );
}

/** A stack of skeleton lines, sized for a table or a list. */
export function SkeletonRows({
  rows = 6,
  height = 16,
}: {
  rows?: number;
  height?: number;
}): JSX.Element {
  return (
    <div className="stack-sm" role="status" aria-live="polite" aria-label="Loading">
      {Array.from({ length: rows }, (_value, index) => (
        <Skeleton key={index} height={height} width={index % 3 === 2 ? "72%" : "100%"} />
      ))}
    </div>
  );
}

/** A one-pixel progress line for in-place refreshes. */
export function ProgressLine(): JSX.Element {
  return <div className="progress-line" role="status" aria-label="Loading" />;
}

/** Render a failure using the words the server (or DuckDB) actually produced. */
export function ErrorPanel({
  error,
  onRetry,
}: {
  error: { message: string; detail: string | null };
  onRetry?: () => void;
}): JSX.Element {
  return (
    <div className="notice error" role="alert">
      <h3>{error.message}</h3>
      {error.detail ? <p>{error.detail}</p> : null}
      {onRetry ? (
        <div className="mode-actions">
          <button type="button" className="btn small" onClick={onRetry}>
            Try again
          </button>
        </div>
      ) : null}
    </div>
  );
}

export type Tone = "neutral" | "ok" | "warn" | "bad" | "accent";

/** A text badge. The word is the meaning; the colour only reinforces it. */
export function Badge({
  tone = "neutral",
  mono = false,
  children,
  title,
}: {
  tone?: Tone;
  mono?: boolean;
  children: ReactNode;
  title?: string;
}): JSX.Element {
  const classes = ["badge", tone === "neutral" ? "" : tone, mono ? "mono" : ""]
    .filter((part) => part.length > 0)
    .join(" ");
  return (
    <span className={classes} title={title}>
      {children}
    </span>
  );
}

/** A headline figure with an uppercase micro-label and optional footnote. */
export function StatTile({
  label,
  value,
  note,
  tone = "neutral",
  loading = false,
}: {
  label: string;
  value: string;
  note?: string;
  tone?: "neutral" | "accent" | "warn" | "ok";
  loading?: boolean;
}): JSX.Element {
  return (
    <div className="tile">
      <span className="micro">{label}</span>
      {loading ? (
        <Skeleton height={22} width="70%" />
      ) : (
        <span className={`tile-value ${tone === "neutral" ? "" : tone}`}>{value}</span>
      )}
      {note ? <span className="tile-note">{note}</span> : null}
    </div>
  );
}

/** A titled panel with an optional right-hand slot. */
export function Panel({
  title,
  subtitle,
  actions,
  children,
}: {
  title?: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="panel">
      {title || actions ? (
        <header className="panel-head">
          <div className="panel-title">
            {title ? <h2>{title}</h2> : null}
            {subtitle ? <span className="prose">{subtitle}</span> : null}
          </div>
          {actions ? <div className="row">{actions}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

/** Empty-result state. Never used to hide a loading state. */
export function EmptyState({ children }: { children: ReactNode }): JSX.Element {
  return <div className="empty">{children}</div>;
}
