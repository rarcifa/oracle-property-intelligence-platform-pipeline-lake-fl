/**
 * CentralSquare eTRAKiT vendor module for the shared permit-harvest service.
 *
 * `county-permit-adapter` describes a vendor module as something the
 * `PermitHarvest` service dispatches to by adapter key, given a parcel id: it
 * searches the portal for that parcel, lists the permits it finds, captures
 * each one's detail, and binds every record to the parcel the caller asked
 * for. This is that module for eTRAKiT, and `etrakit` was already one of the
 * three adapter keys `src/counties/permit-profile.mjs` admits — it simply had
 * no implementation behind it until now.
 *
 * All the portal knowledge lives in {@link module:counties/lake/clermont-permits},
 * which parses and normalizes with no network of its own. This file is the
 * thin dispatch surface: it owns the adapter contract
 * (`probe` / `searchParcel` / `fetchPermitDetail`), the per-adapter session and
 * the contractor-licence index, and nothing else.
 *
 * **Zero rows is a clean completion, not a failure.** Lake routes parcels to a
 * jurisdiction by mailing city, and mailing city over-selects Clermont badly —
 * 50,447 seed parcels carry a CLERMONT mailing city while the portal itself
 * knows about 2,656 parcels per permit year, because much of south Lake posts
 * to a Clermont address while sitting in unincorporated county. A search that
 * returns nothing therefore means "this parcel is not Clermont's", which the
 * kit's taxonomy records as done with zero permits and never retries.
 *
 * @module counties/lake/etrakit-adapter
 */

import {
  buildContractorLicenseIndex,
  createClermontPermitSession,
  normalizeClermontPermit,
  parseContractorLicenseDirectory,
  permitDetailUrl,
  CLERMONT_ETRAKIT_SEARCH_URL,
} from "./clermont-permits.mjs";
import { PermitSourceError } from "../../permits/errors.mjs";

export const ETRAKIT_ADAPTER_KEY = "etrakit";

/**
 * Normalize a parcel identifier for an eTRAKiT parcel search.
 *
 * The portal's parcel field is labelled "AK NUMBER" and posts as `SITE_APN`;
 * it holds the Florida DOR `ALT_KEY`, which the Lake seed and query table
 * already carry, so the join needs no translation — only the punctuation strip
 * that `county-permit-adapter` requires of every vendor module, because an
 * appraisal parcel format is rarely the permit portal's format.
 *
 * @param {string} value - Parcel identifier as the caller holds it.
 * @returns {string} Digits-only alternate key.
 */
export function normalizeEtrakitParcelSearchValue(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length === 0) {
    throw new PermitSourceError(`Invalid eTRAKiT parcel identifier "${String(value ?? "")}"`, {
      classification: "permanent",
      code: "invalid_parcel_identifier",
    });
  }
  return digits;
}

/**
 * Create an eTRAKiT vendor module for one jurisdiction.
 *
 * @param {object} jurisdiction - Jurisdiction row from the county's permit profile or sources catalog.
 * @param {object} [options] - Adapter options.
 * @param {object} [options.session] - Pre-built session, for tests.
 * @param {typeof fetch} [options.fetchImpl] - Injected fetch, for tests.
 * @param {number} [options.maxAttempts] - Attempts per request before a transient error is rethrown.
 * @returns {{ key: string, probe: () => Promise<{ status: string }>, searchParcel: (parcelIdentifier: string) => Promise<object[]>, fetchPermitDetail: (reference: object, request: object) => Promise<object> }}
 *   The vendor module.
 */
export function createEtrakitAdapter(jurisdiction, options = {}) {
  const config = jurisdiction.adapterConfig ?? {};
  const baseUrl = config.baseUrl ?? CLERMONT_ETRAKIT_SEARCH_URL;
  const session =
    options.session ??
    createClermontPermitSession({
      baseUrl,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      maxAttempts: options.maxAttempts ?? 4,
    });

  /** @type {Map<string, string> | null} */
  let licenseIndex = null;
  /**
   * The licence directory is one page on the portal and is the same for every
   * parcel, so it is fetched once per adapter and shared across the harvest.
   *
   * @returns {Promise<Map<string, string>>} Contractor name to licence number.
   */
  async function ensureLicenseIndex() {
    if (licenseIndex === null) licenseIndex = await session.loadContractorLicenseIndex();
    return licenseIndex;
  }

  return Object.freeze({
    key: ETRAKIT_ADAPTER_KEY,
    async probe() {
      const directory = await session.loadContractorLicenseIndex().catch(() => null);
      if (directory === null) return { status: "unexpected" };
      licenseIndex = directory;
      return { status: "ok" };
    },
    async searchParcel(parcelIdentifier) {
      const alternateKey = normalizeEtrakitParcelSearchValue(parcelIdentifier);
      const result = await session.searchByAlternateKey(alternateKey);
      return result.rows.map((row) => ({
        ...row,
        sourceRecordId: row.recordId ?? row.permitNumber,
        sourceUrl: permitDetailUrl(row.permitNumber),
      }));
    },
    async fetchPermitDetail(reference, request) {
      const alternateKey = normalizeEtrakitParcelSearchValue(request.requestedParcelIdentifier);
      const { detail } = await session.fetchPermitDetail(reference.permitNumber);
      return normalizeClermontPermit({
        detail,
        row: reference,
        requestedAlternateKey: alternateKey,
        requestedPropertyId: request.requestedPropertyId ?? null,
        licenseIndex: await ensureLicenseIndex(),
      });
    },
  });
}

/**
 * Rebuild a contractor-licence index from an already-fetched search page.
 *
 * Exposed so a caller that holds the bootstrap HTML — a replay, a fixture, a
 * test — can build the index without a second request.
 *
 * @param {string} html - Search-page HTML.
 * @returns {Map<string, string>} Contractor name to licence number.
 */
export function licenseIndexFromSearchPage(html) {
  return buildContractorLicenseIndex(parseContractorLicenseDirectory(html));
}
