/**
 * Offset paging with the real matched count spelled out.
 *
 * The matched total is printed in full and never abbreviated: "Showing 1-50 of
 * N matching parcels" is a claim about the dataset, and the exact N is the
 * claim. It always comes from the query's own count, never from this file.
 */

import { formatCount } from "../lib/format.js";

export function Pager({
  offset,
  limit,
  matched,
  returned,
  onOffset,
  busy,
}: {
  offset: number;
  limit: number;
  matched: number;
  returned: number;
  onOffset: (next: number) => void;
  busy: boolean;
}): JSX.Element {
  const first = matched === 0 ? 0 : offset + 1;
  const last = offset + returned;
  const canPrev = offset > 0;
  const canNext = last < matched;

  return (
    <div className="table-foot">
      <span>
        Showing <strong className="mono">{formatCount(first)}</strong>–
        <strong className="mono">{formatCount(last)}</strong> of{" "}
        <strong className="mono">{formatCount(matched)}</strong> matching parcels
      </span>
      <div className="row">
        <button
          type="button"
          className="btn small"
          disabled={!canPrev || busy}
          onClick={() => onOffset(Math.max(0, offset - limit))}
        >
          ← Previous
        </button>
        <button
          type="button"
          className="btn small"
          disabled={!canNext || busy}
          onClick={() => onOffset(offset + limit)}
        >
          Next →
        </button>
      </div>
    </div>
  );
}
