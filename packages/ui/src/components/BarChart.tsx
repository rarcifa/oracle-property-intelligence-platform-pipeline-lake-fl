/**
 * Hand-written SVG bar charts. No chart library, by design.
 *
 * Two shapes are supported: a plain horizontal bar list, and a stacked variant
 * used for the roof-age histogram where each band is split by how the age was
 * derived (completed permit / issued permit / year built). Every bar carries
 * its exact value as text, so the chart is readable without colour and the
 * numbers are never approximations of the underlying count.
 */

import { formatCount } from "../lib/format.js";

export interface BarDatum {
  label: string;
  value: number;
  /** Optional stacked breakdown; the parts must sum to at most `value`. */
  parts?: { key: string; value: number }[];
}

export interface SeriesStyle {
  key: string;
  label: string;
  color: string;
}

const ROW_HEIGHT = 26;
const LABEL_WIDTH = 132;
const VALUE_WIDTH = 92;

export function BarChart({
  data,
  series,
  emptyText = "No rows in this breakdown.",
  ariaLabel,
}: {
  data: readonly BarDatum[];
  /** When given, bars are stacked by `parts` using these colours. */
  series?: readonly SeriesStyle[];
  emptyText?: string;
  ariaLabel: string;
}): JSX.Element {
  if (data.length === 0) return <div className="empty">{emptyText}</div>;

  const max = data.reduce((acc, datum) => Math.max(acc, datum.value), 0);
  const height = data.length * ROW_HEIGHT + 8;
  const trackWidth = 420;
  const width = LABEL_WIDTH + trackWidth + VALUE_WIDTH;

  return (
    <div className="chart">
      <svg
        width="100%"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMinYMin meet"
        role="img"
        aria-label={ariaLabel}
        style={{ minWidth: 520 }}
      >
        {data.map((datum, index) => {
          const y = index * ROW_HEIGHT + 4;
          const scale = max > 0 ? trackWidth / max : 0;
          let cursor = LABEL_WIDTH;
          return (
            <g key={`${datum.label}-${index}`}>
              <text
                x={LABEL_WIDTH - 10}
                y={y + 13}
                textAnchor="end"
                fontSize="11"
                fill="#8d9cb2"
                fontFamily="var(--sans)"
              >
                {datum.label}
              </text>
              <rect
                x={LABEL_WIDTH}
                y={y + 3}
                width={trackWidth}
                height={13}
                rx={2}
                fill="rgba(255,255,255,0.035)"
              />
              {series && datum.parts ? (
                series.map((style) => {
                  const part = datum.parts?.find((entry) => entry.key === style.key);
                  const partWidth = Math.max(0, (part?.value ?? 0) * scale);
                  const x = cursor;
                  cursor += partWidth;
                  if (partWidth <= 0) return null;
                  return (
                    <rect
                      key={style.key}
                      x={x}
                      y={y + 3}
                      width={partWidth}
                      height={13}
                      fill={style.color}
                    >
                      <title>{`${datum.label} · ${style.label}: ${formatCount(part?.value ?? 0)}`}</title>
                    </rect>
                  );
                })
              ) : (
                <rect
                  x={LABEL_WIDTH}
                  y={y + 3}
                  width={Math.max(0, datum.value * scale)}
                  height={13}
                  rx={2}
                  fill="#5fc6d9"
                >
                  <title>{`${datum.label}: ${formatCount(datum.value)}`}</title>
                </rect>
              )}
              <text
                x={LABEL_WIDTH + trackWidth + 10}
                y={y + 13}
                fontSize="11"
                fill="#dbe4f0"
                fontFamily="var(--mono)"
              >
                {formatCount(datum.value)}
              </text>
            </g>
          );
        })}
      </svg>
      {series ? (
        <div className="chart-legend">
          {series.map((style) => (
            <span key={style.key}>
              <span className="swatch" style={{ background: style.color }} />
              {style.label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Colours for the roof-age basis split, reused by every view that shows it. */
export const ROOF_BASIS_SERIES: readonly SeriesStyle[] = [
  { key: "from_completed_permit", label: "Completed roofing permit", color: "#5ed39a" },
  { key: "from_issued_permit", label: "Issued roofing permit", color: "#5fc6d9" },
  { key: "from_year_built", label: "Year built (no roofing permit)", color: "#e8b269" },
];
