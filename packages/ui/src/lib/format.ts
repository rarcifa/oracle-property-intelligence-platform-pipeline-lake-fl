/**
 * Number, currency and identifier formatting.
 *
 * Counts are never rounded or abbreviated: a parcel count is a fact, and
 * "215.8k" is not that fact. `Intl.NumberFormat` instances are created once and
 * reused because constructing them per cell is measurably slow in long tables.
 */

const COUNT_FORMAT = new Intl.NumberFormat("en-US");
const DECIMAL_FORMAT = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});
const CURRENCY_FORMAT = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const PERCENT_FORMAT = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 1,
});

/** An exact integer count, grouped. Never abbreviated. */
export function formatCount(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return COUNT_FORMAT.format(value);
}

/** A general number with up to two decimals. */
export function formatNumber(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return DECIMAL_FORMAT.format(value);
}

/** Whole-dollar currency. */
export function formatCurrency(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return CURRENCY_FORMAT.format(value);
}

/** A share of a whole, rendered as a percentage. */
export function formatPercent(part: number, whole: number): string {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole === 0) return "—";
  return PERCENT_FORMAT.format(part / whole);
}

/** A published date string, shown as-is when it is not parseable. */
export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toISOString().slice(0, 10);
}

/** Abbreviate a CID for display while keeping both ends recognisable. */
export function shortCid(cid: string | null | undefined, head = 10, tail = 6): string {
  if (!cid) return "—";
  if (cid.length <= head + tail + 1) return cid;
  return `${cid.slice(0, head)}…${cid.slice(-tail)}`;
}

/** Turn a snake_case key into a readable label. */
export function humanizeKey(key: string): string {
  return key
    .split("_")
    .map((part) => (part.length > 0 ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(" ");
}

/** Days rendered as a human duration, keeping the exact day count visible. */
export function formatDays(days: number | null | undefined): string {
  if (typeof days !== "number" || !Number.isFinite(days)) return "—";
  if (days < 365) return `${formatCount(days)} days`;
  const years = days / 365;
  return `${formatCount(days)} days (${DECIMAL_FORMAT.format(years)} yr)`;
}
