/**
 * Jurisdiction routing for the Lake County permit track.
 *
 * `county-permit-adapter` describes the shape: a county spans dozens of
 * municipal jurisdictions and potentially several permit vendors, so the
 * harvest service loads the county's sources catalog, resolves each parcel's
 * jurisdiction from stored situs city, groups by vendor, and dispatches to the
 * matching vendor module. An ambiguous or unmatched jurisdiction is recorded
 * `unrouted` rather than guessed. This module is that resolver for Lake.
 *
 * The table below mirrors `docs/lake-sources.yaml`, which is the machine-
 * readable registry `county-discovery` writes and the record of truth.
 * `tests/lake-permit-routing.test.mjs` reads that YAML and fails if the two
 * drift, so the catalog stays the source and this stays a projection of it
 * rather than a second, quietly diverging copy.
 *
 * **Situs city is a weak routing signal in Lake, and the numbers say so.**
 * 50,447 seed parcels carry a CLERMONT mailing city; a spatial test of the
 * county's own permit layer puts only 45 of 17,915 permitted parcels inside
 * *any* city limit, and Clermont's portal knows roughly 2,656 parcels per
 * permit year. Much of south Lake posts to a Clermont address while sitting in
 * unincorporated county. Routing therefore produces a *candidate* set, not a
 * membership claim: the portal itself is the authority, and a parcel search
 * that returns nothing is recorded as done with zero permits — the kit's
 * clean-completion rule — not as a failure and not as a jurisdiction error.
 *
 * **Kit deviation, recorded.** This is a routing table beside the catalog rather
 * than a registered `permitProfileRegistry` entry, because the profile schema
 * cannot express Lake's default jurisdiction without asserting something false
 * about it. `docs/lake-kit-deviations.md` §22 has the reasoning and §3 the
 * underlying schema gap.
 *
 * @module counties/lake/permit-routing
 */

/**
 * @typedef {object} LakePermitJurisdiction
 * @property {string} key - Catalog jurisdiction key.
 * @property {string} name - Jurisdiction display name.
 * @property {string} vendor - Permit-system vendor, as catalogued.
 * @property {string | null} adapterKey - Registered vendor-module key, or null when none exists.
 * @property {"supported" | "blocked" | "manual-only" | "unavailable"} status - Catalog access status.
 * @property {boolean} historicalRecords - Whether the source carries permit history.
 * @property {readonly string[]} routingCities - Situs-city aliases that route here.
 * @property {boolean} defaultForUnmatchedCity - Whether an unmatched, non-empty city routes here.
 * @property {"parcel-keyed" | "bulk-export" | "none"} harvestMode - How the source is actually acquired.
 */

/** @type {readonly LakePermitJurisdiction[]} */
export const LAKE_PERMIT_JURISDICTIONS = Object.freeze(
  [
    {
      key: "unincorporated",
      name: "Unincorporated Lake County",
      vendor: "Perconti CD Plus via Esri MapServer proxy",
      adapterKey: null,
      status: "supported",
      historicalRecords: false,
      routingCities: [],
      defaultForUnmatchedCity: true,
      // The county layer is a whole-layer Esri page walk, not one request per
      // parcel: 17,915 features in 6.5 s. It is acquired by
      // `counties/lake/sources`, so no parcel-keyed adapter exists or should.
      harvestMode: "bulk-export",
    },
    {
      key: "clermont",
      name: "Clermont",
      vendor: "CentralSquare eTRAKiT 3",
      adapterKey: "etrakit",
      status: "supported",
      historicalRecords: true,
      routingCities: ["CLERMONT"],
      defaultForUnmatchedCity: false,
      harvestMode: "parcel-keyed",
    },
    {
      key: "groveland",
      name: "Groveland",
      vendor: "CentralSquare eTRAKiT on aspgov.com",
      adapterKey: null,
      status: "blocked",
      historicalRecords: true,
      routingCities: ["GROVELAND"],
      defaultForUnmatchedCity: false,
      harvestMode: "none",
    },
    {
      key: "eustis",
      name: "Eustis",
      vendor: "Citizenserve",
      adapterKey: null,
      status: "blocked",
      historicalRecords: true,
      routingCities: ["EUSTIS"],
      defaultForUnmatchedCity: false,
      harvestMode: "none",
    },
    {
      key: "minneola",
      name: "Minneola",
      vendor: "unknown, building official contracted to SAFEbuilt",
      adapterKey: null,
      status: "blocked",
      historicalRecords: true,
      routingCities: ["MINNEOLA"],
      defaultForUnmatchedCity: false,
      harvestMode: "none",
    },
    {
      key: "leesburg",
      name: "Leesburg",
      vendor: "CD Plus OPRS since 2021-09-01, Click2Gov before it",
      adapterKey: null,
      status: "blocked",
      historicalRecords: true,
      routingCities: ["LEESBURG"],
      defaultForUnmatchedCity: false,
      harvestMode: "none",
    },
    {
      key: "tavares",
      name: "Tavares",
      vendor: "CentralSquare Click2Gov",
      adapterKey: null,
      status: "unavailable",
      historicalRecords: true,
      routingCities: ["TAVARES"],
      defaultForUnmatchedCity: false,
      harvestMode: "none",
    },
    {
      key: "mount-dora",
      name: "Mount Dora",
      vendor: "BS&A Online",
      adapterKey: null,
      status: "blocked",
      historicalRecords: true,
      routingCities: ["MOUNT DORA", "MT DORA"],
      defaultForUnmatchedCity: false,
      harvestMode: "none",
    },
    {
      key: "umatilla",
      name: "Umatilla",
      vendor: "none",
      adapterKey: null,
      status: "manual-only",
      historicalRecords: false,
      routingCities: ["UMATILLA"],
      defaultForUnmatchedCity: false,
      harvestMode: "none",
    },
    {
      key: "astatula",
      name: "Astatula",
      vendor: "none",
      adapterKey: null,
      status: "manual-only",
      historicalRecords: false,
      routingCities: ["ASTATULA"],
      defaultForUnmatchedCity: false,
      harvestMode: "none",
    },
    {
      key: "fruitland-park",
      name: "Fruitland Park",
      vendor: "BS&A Online",
      adapterKey: null,
      status: "blocked",
      historicalRecords: true,
      routingCities: ["FRUITLAND PARK"],
      defaultForUnmatchedCity: false,
      harvestMode: "none",
    },
    {
      key: "howey-in-the-hills",
      name: "Howey-in-the-Hills",
      vendor: "iWorq",
      adapterKey: null,
      status: "blocked",
      historicalRecords: true,
      routingCities: ["HOWEY IN THE HILLS", "HOWEY-IN-THE-HILLS"],
      defaultForUnmatchedCity: false,
      harvestMode: "none",
    },
    {
      key: "lady-lake",
      name: "Lady Lake",
      vendor: "Citizenserve",
      adapterKey: null,
      status: "blocked",
      historicalRecords: true,
      routingCities: ["LADY LAKE"],
      defaultForUnmatchedCity: false,
      harvestMode: "none",
    },
    {
      key: "mascotte",
      name: "Mascotte",
      vendor: "iWorq",
      adapterKey: null,
      status: "blocked",
      historicalRecords: true,
      routingCities: ["MASCOTTE"],
      defaultForUnmatchedCity: false,
      harvestMode: "none",
    },
    {
      key: "montverde",
      name: "Montverde",
      vendor: "iWorq not yet live, Citizenserve installation 401",
      adapterKey: null,
      status: "manual-only",
      historicalRecords: false,
      routingCities: ["MONTVERDE"],
      defaultForUnmatchedCity: false,
      harvestMode: "none",
    },
  ].map((jurisdiction) => Object.freeze({ ...jurisdiction, routingCities: Object.freeze(jurisdiction.routingCities) })),
);

/**
 * Sentinel recorded in a parcel's status JSON when no jurisdiction can be
 * resolved. `county-permit-adapter` requires this to be a recorded outcome,
 * not a silent fallback.
 */
export const UNROUTED = "unrouted";

/**
 * @param {string | null | undefined} city - Situs or mailing city.
 * @returns {string} Uppercased, whitespace-collapsed city.
 */
function normalizeCity(city) {
  return String(city ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
}

/**
 * Resolve one parcel's permit jurisdiction from its situs city.
 *
 * A blank city is `unrouted`: Lake's default jurisdiction exists, but applying
 * it to a parcel with no city at all would be a guess dressed as a routing
 * decision, and the kit says to record the ambiguity instead.
 *
 * @param {string | null | undefined} city - Situs or mailing city.
 * @returns {LakePermitJurisdiction | null} The jurisdiction, or null when unrouted.
 */
export function routeLakeParcel(city) {
  const normalized = normalizeCity(city);
  if (normalized === "") return null;
  const exact = LAKE_PERMIT_JURISDICTIONS.find((jurisdiction) =>
    jurisdiction.routingCities.includes(normalized),
  );
  if (exact !== undefined) return exact;
  return LAKE_PERMIT_JURISDICTIONS.find((jurisdiction) => jurisdiction.defaultForUnmatchedCity) ?? null;
}

/**
 * Group parcels by the vendor module that would harvest them.
 *
 * The `unrouted` bucket is always present in the result — an empty bucket is a
 * reported zero, and a missing bucket would be an absence nobody checked.
 *
 * @param {readonly { parcelIdentifier: string, city?: string | null }[]} parcels - Parcels to route.
 * @returns {{ byJurisdiction: Map<string, { jurisdiction: LakePermitJurisdiction, parcels: string[] }>, unrouted: string[] }}
 *   Routed groups plus the unrouted parcels.
 */
export function groupParcelsByJurisdiction(parcels) {
  /** @type {Map<string, { jurisdiction: LakePermitJurisdiction, parcels: string[] }>} */
  const byJurisdiction = new Map();
  /** @type {string[]} */
  const unrouted = [];
  for (const parcel of parcels) {
    const jurisdiction = routeLakeParcel(parcel.city);
    if (jurisdiction === null) {
      unrouted.push(parcel.parcelIdentifier);
      continue;
    }
    const bucket = byJurisdiction.get(jurisdiction.key) ?? { jurisdiction, parcels: [] };
    bucket.parcels.push(parcel.parcelIdentifier);
    byJurisdiction.set(jurisdiction.key, bucket);
  }
  return { byJurisdiction, unrouted };
}

/**
 * The jurisdictions a parcel-keyed harvest can actually dispatch to: catalogued
 * `supported`, harvested per parcel, and backed by a registered vendor module.
 *
 * @returns {LakePermitJurisdiction[]} Dispatchable jurisdictions.
 */
export function dispatchableJurisdictions() {
  return LAKE_PERMIT_JURISDICTIONS.filter(
    (jurisdiction) =>
      jurisdiction.status === "supported" &&
      jurisdiction.harvestMode === "parcel-keyed" &&
      jurisdiction.adapterKey !== null,
  );
}
