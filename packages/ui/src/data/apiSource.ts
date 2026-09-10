/**
 * `DataSource` implementation backed by the server's REST API.
 *
 * This is the fallback path: the server runs DuckDB over the same published
 * Parquet and answers with the same generated SQL in `provenance.sql`, so the
 * UI cannot tell the two apart except by the mode pill in the header.
 */

import type { PropertyDetailResponse, SearchOptions, SearchResponse } from "@oracle-lake/shared";
import { getJson, postJson } from "./http.js";
import { toSearchParams } from "./searchParams.js";
import type {
  BusinessViewResponse,
  ContractorViewResponse,
  DataSource,
  FacetsResponse,
  SqlResponse,
  StatsResponse,
  TenantViewResponse,
} from "./types.js";

/** Build the REST-backed data source. `dataSource` describes the server's Parquet. */
export function createApiSource(dataSource: string): DataSource {
  return {
    kind: "server",
    label: "Server DuckDB",
    dataSource,

    async search(options: SearchOptions): Promise<SearchResponse> {
      const params = toSearchParams(options);
      const query = params.toString();
      return getJson<SearchResponse>(`/api/properties${query.length > 0 ? `?${query}` : ""}`);
    },

    async getProperty(parcelId: string): Promise<PropertyDetailResponse> {
      return getJson<PropertyDetailResponse>(`/api/properties/${encodeURIComponent(parcelId)}`);
    },

    async getStats(): Promise<StatsResponse> {
      return getJson<StatsResponse>("/api/stats");
    },

    async getFacets(): Promise<FacetsResponse> {
      return getJson<FacetsResponse>("/api/meta/facets");
    },

    async getTenantView(): Promise<TenantViewResponse> {
      return getJson<TenantViewResponse>("/api/views/tenant");
    },

    async getBusinessView(): Promise<BusinessViewResponse> {
      return getJson<BusinessViewResponse>("/api/views/business");
    },

    async getContractorView(): Promise<ContractorViewResponse> {
      return getJson<ContractorViewResponse>("/api/views/contractor");
    },

    async runSql(sql: string, limit?: number): Promise<SqlResponse> {
      return postJson<SqlResponse>("/api/sql", { sql, limit });
    },
  };
}
