import { propertyFiltersSchema } from "@oracle-lake/shared";
import type { TurnMessage } from "./grounding.js";

/** Only this fully understood constraint grammar bypasses model tool selection. */
export interface SupportedRoofRadiusRequest {
  city: string;
  radiusMiles: number;
  roofAgeThreshold: number;
  comparison: "older-than" | "at-least";
  minRoofAge: number;
}

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
};
const NUMBER = `(?:\\d+(?:\\.\\d+)?|${Object.keys(NUMBER_WORDS).join("|")})`;
const LEAD =
  "(?:which|show|list|find|identify|return|give me)\\s+(?:the\\s+)?(?:properties|parcels|homes)";
const SCOPE = "(?:\\s+in\\s+Lake\\s+County(?:\\s*,?\\s*(?:Florida|FL))?)?";
const RADIUS = `within\\s+(${NUMBER})\\s+miles?\\s+of\\s+([a-z][a-z '-]{0,79}?)`;
const ROOF = `(?:that\\s+have|have|with)\\s+roofs?\\s+(older than|over|more than|at least)\\s+(${NUMBER})\\s+years?`;
const REQUEST = new RegExp(`^${LEAD}${SCOPE}\\s+${RADIUS}\\s+${ROOF}\\s*[?.!]*$`, "i");

/**
 * Never drop unparsed restrictions, negations, another county or a follow-up's
 * context. Unrecognized questions continue through the existing SDK tools.
 * Named places are NOT converted to coordinates here.
 */
export function interpretSupportedRoofRadiusRequest(
  messages: readonly TurnMessage[],
): SupportedRoofRadiusRequest | null {
  const question = messages
    .filter((message) => message.role === "user")
    .at(-1)
    ?.content.trim()
    .replace(/\s+/g, " ");
  if (!question) return null;
  const match = REQUEST.exec(question);
  if (!match) return null;
  const numeric = (raw: string): number => NUMBER_WORDS[raw.toLowerCase()] ?? Number(raw);
  const radiusMiles = numeric(match[1] ?? "");
  const city = (match[2] ?? "").trim().toUpperCase();
  const roofAgeThreshold = numeric(match[4] ?? "");
  const comparison = match[3]?.toLowerCase() === "at least" ? "at-least" : "older-than";
  // Published estimated ages are integer years. The shared lower bound is >=,
  // so strict >15 must become >=16, not the opposite side of that boundary.
  const minRoofAge =
    comparison === "older-than" ? Math.floor(roofAgeThreshold) + 1 : Math.ceil(roofAgeThreshold);
  const filters = propertyFiltersSchema.safeParse({ city, radiusMiles, minRoofAge });
  if (!filters.success || !Number.isFinite(roofAgeThreshold)) return null;
  return { city, radiusMiles, roofAgeThreshold, comparison, minRoofAge };
}

/** Bound read-only query waits by the same deadline as the SDK, without resetting it. */
export async function withinTurnDeadline<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const result = await Promise.race([operation(), aborted]);
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
