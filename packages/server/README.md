# `@oracle-lake/server`

One TypeScript process that serves three surfaces on **one port**, over one DuckDB
connection to the published Lake County query table:

| Surface         | Path              | What it is                                                                                                                                            |
| --------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| REST API        | `GET/POST /api/*` | Filtered property search, property detail, dataset statistics, the three named views, coverage/run metadata, and a read-only SQL endpoint             |
| MCP             | `POST /mcp`       | A stateless Model Context Protocol server (JSON-RPC 2.0 over HTTP) exposing eight tools over the same data layer                                      |
| Chat agent      | `POST /api/chat`  | A natural-language agent built on the Vercel AI SDK with Anthropic, whose every answer cites the SQL, the source systems and the parcel ids behind it |
| Single-page app | everything else   | The built `@oracle-lake/ui` bundle, with client-route fallback to `index.html`                                                                        |

Because it is one process behind one URL, the whole application deploys as a single
container or a single Node host with no reverse-proxy fan-out.

---

## Install and run

From the **repository root**:

```bash
# 1. Install (pnpm 10, Node 22.18+)
pnpm install

# 2. Build the shared package, the server and the UI
pnpm run build

# 3. Start the single process (UI + API + MCP + chat on http://localhost:8787)
pnpm run start
```

Or as one command:

```bash
pnpm run serve        # build, then start
```

For development with hot reload on both sides (server on 8787, Vite on 5173 proxying
`/api` and `/mcp` to 8787):

```bash
pnpm run dev
```

Other root commands:

```bash
pnpm run test         # Vitest, all packages
pnpm run typecheck    # tsc --noEmit, all packages
pnpm run lint         # ESLint
pnpm run format       # Prettier --write
```

### Enabling the chat agent

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pnpm run serve
```

Without the key the process still boots and every data surface works; `POST /api/chat`
returns **503 `chat_unavailable`** with an explanation, which the UI renders as a notice.

---

## Configuration

All optional; the defaults point at the locally published run.

| Variable                 | Default                                          | Meaning                                                                                                                                                     |
| ------------------------ | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                   | `8787`                                           | Listen port                                                                                                                                                 |
| `HOST`                   | `0.0.0.0`                                        | Bind address                                                                                                                                                |
| `ORACLE_PARQUET_PATH`    | the newest local published `query-table.parquet` | Local Parquet to open                                                                                                                                       |
| `ORACLE_PARQUET_URL`     | —                                                | IPFS gateway URL to open instead, e.g. `https://ipfs.filebase.io/ipfs/<rootCid>/query-table.parquet`. Takes precedence; DuckDB range-reads it over `httpfs` |
| `ORACLE_RUN_DIR`         | newest directory under `…/publish/lake/runs/`    | Directory holding `coverage.json`, `index.json`, `schema.json`                                                                                              |
| `ORACLE_LATEST_PATH`     | `<repo>/artifacts/latest.json`                   | Published-run pointer (`runId`, `rootCid`, `ipnsName`, …)                                                                                                   |
| `ORACLE_UI_DIST`         | `<repo>/packages/ui/dist`                        | Built SPA to serve at `/`                                                                                                                                   |
| `ANTHROPIC_API_KEY`      | —                                                | Enables `POST /api/chat`                                                                                                                                    |
| `ORACLE_CHAT_MODEL`      | `claude-fable-5-1`                               | Model id passed to the Vercel AI SDK                                                                                                                        |
| `ORACLE_CHAT_TIMEOUT_MS` | `120000`                                         | Wall-clock budget for one chat turn                                                                                                                         |

Deploying with `ORACLE_PARQUET_URL` set to a Filebase gateway URL means the process
holds no dataset of its own — it reads the same immutable CID the browser reads.

---

## REST routes

| Method       | Path                        | Returns                                                                                                                                                        |
| ------------ | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`        | `/api/health`               | `{ ok, county, dataSource, dataSourceKind, runId, rootCid, propertyCount }` — the count is queried, not cached                                                 |
| `GET`        | `/api/meta/run`             | Published-run pointer, the coverage snapshot (including every documented limitation), the usable gateways and the ones deliberately avoided, and `chatEnabled` |
| `GET`        | `/api/meta/schema`          | All 62 columns with type, label and upstream source, plus the always-null columns and the partially-populated ones, each with its reason                       |
| `GET`        | `/api/meta/facets`          | Distinct cities, property types, roof-age bases and ZIPs with counts                                                                                           |
| `GET`        | `/api/stats`                | Headline dataset counts and the roof-age band histogram                                                                                                        |
| `GET`        | `/api/properties`           | Filtered, sorted, paged search + the true matching total                                                                                                       |
| `GET`        | `/api/properties/:parcelId` | One parcel, its contributing sources, and the reason each null column is null                                                                                  |
| `GET`        | `/api/views/tenant`         | Owner-locality and tenure posture, roof-age bands, owner mailing states                                                                                        |
| `GET`        | `/api/views/business`       | DOR TPP business-account signal by city and property type                                                                                                      |
| `GET`        | `/api/views/contractor`     | Permit posture and the contractor/BBB gating notices                                                                                                           |
| `POST`       | `/api/sql`                  | `{ sql, limit? }` — a single read-only `SELECT`/`WITH` against the view `properties`                                                                           |
| `POST`       | `/api/chat`                 | `{ messages }` → `{ answer, citations, model, runId }`, or 503 when no model key                                                                               |
| `GET`/`POST` | `/mcp`                      | MCP endpoint (GET describes it, POST speaks JSON-RPC)                                                                                                          |

### Search parameters

`q`, `city`, `zip`, `propertyType`, `roofAgeBasis`, `minRoofAge`, `maxRoofAge`,
`hasPermits`, `hasOpenRoofingPermit`, `minOpenPermitDays`, `ownerOutOfCounty`,
`ownerOutOfState`, `noRecordedSale`, `hasBusinessAccount`, `minMarketValue`,
`maxMarketValue`, `minBuiltYear`, `maxBuiltYear`, `lat`, `lon`, `radiusMiles`,
`requireCoordinates`, `limit` (≤500), `offset`, `sortBy`, `sortDir`.

`lat`, `lon` and `radiusMiles` must be supplied together; matching rows carry a
`distance_miles` column and are ordered nearest first.

Every data-bearing response carries a `provenance` block:

```json
{
  "sql": "SELECT * FROM properties WHERE roof_age_years >= 15 ORDER BY …",
  "dataSource": "/…/query-table.parquet",
  "dataSourceKind": "local",
  "sourceSystems": ["FL DOR NAL 2026 preliminary tax roll", "…"],
  "runId": "20260909T182356Z",
  "rootCid": null
}
```

---

## MCP tools

`POST /mcp` speaks JSON-RPC 2.0 and implements `initialize`, `tools/list`,
`tools/call`, `ping`, `resources/list`, `prompts/list`, notifications (answered with
`202` and no body) and batches. It is **stateless**: no session id, no SSE.

| Tool                     | Purpose                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| `getPropertyQuerySchema` | The 62 columns with types, labels, sources, and the null and partially-populated columns with reasons |
| `queryProperties`        | Arbitrary **read-only** `SELECT`/`WITH` against the view `properties`; anything mutating is rejected  |
| `getOracleDatasetInfo`   | Run identity, live counts queried from the Parquet, coverage tables, and every documented limitation  |
| `listOracleProperties`   | Filtered/sorted/paged search with the true matching total                                             |
| `getOracleProperty`      | One parcel with sources and gating reasons                                                            |
| `findAgedRoofs`          | Roof age at or above a threshold (default 15 years), with `roof_age_basis` on every row               |
| `findOpenRoofPermits`    | Parcels with an open roofing permit, longest-open first                                               |
| `findPropertiesInRadius` | Parcels within a radius of a point, nearest first, with `distance_miles`                              |

Smoke test:

```bash
curl -s localhost:8787/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize",
       "params":{"protocolVersion":"2025-06-18","capabilities":{},
                 "clientInfo":{"name":"curl","version":"1"}}}'

curl -s localhost:8787/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

curl -s localhost:8787/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call",
       "params":{"name":"findAgedRoofs","arguments":{"minRoofAge":25,"city":"CLERMONT","limit":3}}}'
```

To register it with an MCP client:

```json
{
  "mcpServers": {
    "oracle-lake-fl": { "type": "http", "url": "http://localhost:8787/mcp" }
  }
}
```

---

## Honesty guarantees enforced in code

- `bbb_rating` is a real column that is null for every row because bbb.org answers
  HTTP 403. `contractor_name` is a real column that is **populated for Clermont
  parcels only** — one of Lake County's fifteen permitting jurisdictions, and the
  only one whose permit portal publishes a contractor of record — and null on the
  rest of the county. `/api/stats` and the contractor view report
  `contractor_names_present` and `bbb_ratings_present` as **queried counts**, so
  neither the zero nor the non-zero is asserted, and the contractor tile states the
  jurisdiction boundary beside the number so a count is never read as countywide
  coverage.
- Where `contractor_name` is null, `enrichment_status` says which null it is:
  `contractor_gated_403` when no source covering the parcel publishes a contractor
  at all, `contractor_absent_on_permit` when Clermont published the permits and none
  named anybody. Every property detail renders that reason instead of a blank cell.
  `/api/meta/schema` serves `alwaysNullColumns` and `partiallyPopulatedColumns`
  separately for the same reason: a column published for part of the county is not
  an always-null column, and calling it one understates the data.
- `no_recorded_sale_in_dor_window` is returned with an explicit tenure caveat: the
  published roll carries only 2025–2026 sales, so it is a lower bound, not tenure.
- The chat agent's system prompt forbids stating any number not obtained from a tool
  call in that turn, and requires the source systems and parcel ids behind each claim.
- The consumer-side schema gate (`assertSchemaMatches`) runs at boot: if the opened
  Parquet does not carry exactly the 62 published columns in order, the process fails
  to start rather than serving a silently wrong table.

---

## Layout

```
src/
├── config.ts             environment → ServerConfig
├── context.ts            AppContext: config + store + cached run identity
├── app.ts                composition root; one Router with all surfaces
├── index.ts              node:http adapter and boot sequence
├── data/
│   ├── duckdb.ts         the single DuckDB connection and value normalisation
│   ├── queries.ts        high-level queries + provenance
│   └── run.ts            coverage.json / latest.json readers
├── http/
│   ├── router.ts         testable request/response router
│   └── static.ts         SPA static handler with traversal protection
├── routes/
│   ├── api.ts            REST routes
│   └── chat.ts           /api/chat, incl. the 503 path
├── mcp/
│   ├── server.ts         JSON-RPC 2.0 dispatch
│   └── tools.ts          tool definitions and handlers
└── chat/
    └── agent.ts          Vercel AI SDK agent with Zod tool schemas
tests/                    Vitest suites: router, static, duckdb, queries, api, mcp, chat
```

SQL is _not_ built here — it comes from `@oracle-lake/shared`, which the browser's
DuckDB-WASM path uses too, so a browser answer and a server answer are generated by
the same code against the same Parquet.
