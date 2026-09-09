/**
 * The `DataSource` contract and the response shapes the two implementations
 * share.
 *
 * Everything the UI renders goes through this interface, so the browser
 * implementation (DuckDB-WASM range-reading the published Parquet over IPFS)
 * and the server implementation (REST against the Node DuckDB service) are
 * interchangeable at runtime. Response shapes mirror the server's documented
 * routes exactly; the types that are already published by `@oracle-lake/shared`
 * (search, property detail, provenance, chat) are re-used rather than redefined.
 */

import type {
  GatingNotice,
  IpfsGateway,
  LatestRunPointer,
  PropertyDetailResponse,
  QueryTableColumn,
  ResponseProvenance,
  SearchOptions,
  SearchResponse,
} from "@oracle-lake/shared";

/** One bucket of the roof-age histogram, split by how the age was derived. */
export interface RoofAgeBand {
  band: string;
  properties: number;
  from_completed_permit: number;
  from_issued_permit: number;
  from_year_built: number;
}

/** `GET /api/stats`. */
export interface StatsResponse {
  stats: Record<string, number>;
  roofAgeBands: RoofAgeBand[];
  provenance: ResponseProvenance;
}

/** One distinct value of a low-cardinality column, with its row count. */
export interface FacetValue {
  value: string;
  count: number;
}

/** `GET /api/meta/facets`. */
export interface FacetsResponse {
  cities: FacetValue[];
  propertyTypes: FacetValue[];
  roofAgeBasis: FacetValue[];
  zips: FacetValue[];
}

/** `GET /api/views/tenant`. */
export interface TenantViewResponse {
  ownerPosture: Record<string, number>;
  roofAgeBands: RoofAgeBand[];
  topOutOfStateOwners: { owner_mailing_state: string; properties: number }[];
  provenance: ResponseProvenance;
}

/** Business-account concentration for one city. */
export interface BusinessByCity {
  city: string;
  properties_with_accounts: number;
  business_accounts: number;
  properties: number;
}

/** Business-account concentration for one property type. */
export interface BusinessByType {
  property_type: string;
  properties_with_accounts: number;
  business_accounts: number;
}

/** `GET /api/views/business`. */
export interface BusinessViewResponse {
  totals: Record<string, number>;
  byCity: BusinessByCity[];
  byType: BusinessByType[];
  provenance: ResponseProvenance;
  note: string;
}

/** `GET /api/views/contractor`. */
export interface ContractorViewResponse {
  posture: Record<string, number>;
  gating: GatingNotice[];
  provenance: ResponseProvenance;
  note: string;
}

/** `POST /api/sql`. */
export interface SqlResponse {
  rows: Record<string, unknown>[];
  rowCount: number;
  sql: string;
  provenance: ResponseProvenance;
}

/** The published `coverage.json`, served verbatim by `GET /api/meta/run`. */
export interface CoverageSnapshot {
  schemaVersion: string;
  county: string;
  countyName: string;
  stateCode: string;
  countyFips: string;
  runId: string;
  exportedAt: string;
  denominator: {
    basis: string;
    source: string;
    assessedParcelCount: number;
  };
  tables: Record<string, { rows: number; source: string }>;
  signals: Record<string, number>;
  limitations: string[];
}

/** One artifact checked against several independent gateways. */
export interface ArtifactVerification {
  name: string;
  cid: string;
  verified: boolean;
  matchedGateways: string[];
  minimumIndependentGateways: number;
  results: {
    gateway: string;
    ok: boolean;
    status: number | null;
    bytes: number | null;
    sha256: string | null;
    error: string | null;
  }[];
}

/** `artifacts/verification-<runId>.json`, as served by `/api/meta/run`. */
export interface VerificationReport {
  runId: string;
  rootCid: string;
  verifications: ArtifactVerification[];
}

/** `artifacts/run-history.json`, as served by `/api/meta/run`. */
export interface RunHistory {
  schemaVersion: string;
  runs: { runId: string; startedAt?: string; finishedAt?: string; mode?: string }[];
}

/** `GET /api/meta/run`. */
export interface RunMetaResponse {
  run: LatestRunPointer | null;
  coverage: CoverageSnapshot | null;
  verification: VerificationReport | null;
  runHistory: RunHistory | null;
  dataSource: string;
  dataSourceKind: "ipfs" | "local";
  gateways: IpfsGateway[];
  unusableGateways: { host: string; reason: string }[];
  chatEnabled: boolean;
}

/** `GET /api/meta/schema`. */
export interface SchemaMetaResponse {
  columnCount: number;
  columns: QueryTableColumn[];
}

/** `GET /api/health`. */
export interface HealthResponse {
  ok: boolean;
  dataSource: string;
  dataSourceKind: "ipfs" | "local";
  runId: string | null;
  rootCid: string | null;
  propertyCount: number;
}

/**
 * The single abstraction every view reads through.
 *
 * `kind` says which implementation answered, and `dataSource` is the concrete
 * location the rows came from (an IPFS gateway URL, or the server's own
 * description of its Parquet). Both are surfaced in the UI so a reviewer can
 * see where a number was computed.
 */
export interface DataSource {
  readonly kind: "browser" | "server";
  readonly label: string;
  readonly dataSource: string;
  search(options: SearchOptions): Promise<SearchResponse>;
  getProperty(parcelId: string): Promise<PropertyDetailResponse>;
  getStats(): Promise<StatsResponse>;
  getFacets(): Promise<FacetsResponse>;
  getTenantView(): Promise<TenantViewResponse>;
  getBusinessView(): Promise<BusinessViewResponse>;
  getContractorView(): Promise<ContractorViewResponse>;
  runSql(sql: string, limit?: number): Promise<SqlResponse>;
}

/** Thrown by both implementations so views can render the server's own words. */
export class DataSourceError extends Error {
  readonly status: number | null;
  readonly detail: string | null;

  constructor(message: string, status: number | null = null, detail: string | null = null) {
    super(message);
    this.name = "DataSourceError";
    this.status = status;
    this.detail = detail;
  }
}
