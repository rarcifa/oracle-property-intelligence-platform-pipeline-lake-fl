/**
 * Process entry point: the `node:http` adapter around the router.
 *
 * This is the only file that touches sockets and streams. Boot order matters:
 * the DuckDB store opens and passes its schema gate *before* the port is bound,
 * so a process that is listening is a process that can answer.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createContext } from "./context.js";
import { REFRESH_INTERVAL_MS, RuntimeDataset } from "./data/source.js";
import type { HttpResponse } from "./http/router.js";
import type { Router } from "./http/router.js";

const MAX_BODY_BYTES = 1_000_000;

async function readBody(request: IncomingMessage): Promise<unknown> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim().length === 0) return undefined;
  const contentType = request.headers["content-type"] ?? "";
  if (
    contentType.includes("application/json") ||
    text.trimStart().startsWith("{") ||
    text.trimStart().startsWith("[")
  ) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return { __parseError: true };
    }
  }
  return text;
}

function send(response: ServerResponse, result: HttpResponse): void {
  response.writeHead(result.status, result.headers);
  response.end(result.body);
}

/** Adapt a `node:http` request onto the router. */
export function createRequestListener(router: Router) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    try {
      const body = await readBody(request);
      const result = await router.handle({
        method: request.method ?? "GET",
        path: url.pathname,
        query: url.searchParams,
        headers: request.headers as Record<string, string | undefined>,
        body,
      });
      send(response, result);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(
        JSON.stringify({ level: "error", msg: "request_failed", path: url.pathname, detail }),
      );
      send(response, {
        status: 500,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: "internal_error", detail }),
      });
    }
  };
}

/** Open the data layer, wire the app, and start listening. */
export async function main(): Promise<void> {
  const config = loadConfig();
  const startedAt = Date.now();
  let dataset: RuntimeDataset;
  let opened: Awaited<ReturnType<typeof RuntimeDataset.open>>;
  try {
    opened = await RuntimeDataset.open(config);
    dataset = opened.dataset;
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "no_parquet_source",
        detail: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exit(1);
  }

  const store = dataset.store;
  const propertyCount = Number(await store.queryScalar("SELECT count(*) FROM properties"));

  const context = createContext(config, dataset);
  const router = createApp(context);
  const server = createServer(createRequestListener(router));

  server.listen(config.port, config.host, () => {
    console.log(
      JSON.stringify({
        level: "info",
        msg: "listening",
        url: `http://localhost:${config.port}`,
        dataSource: store.source,
        dataSourceKind: store.sourceKind,
        ipnsName: dataset.pointer?.ipnsName ?? null,
        rootCid: dataset.pointer?.rootCid ?? null,
        pointerOrigin: dataset.pointer?.origin ?? "configured",
        resolveMs: opened.resolveMs,
        openMs: opened.openMs,
        propertyCount,
        chatEnabled: config.anthropicApiKey !== null,
        bootMs: Date.now() - startedAt,
      }),
    );
  });

  // A long-lived local process follows the pointer too, on the same terms as
  // the deployed one: never on the request path, and never fatal.
  const refresh = setInterval(() => {
    void dataset.refresh().then((outcome) => {
      if (outcome.status === "upgraded") {
        console.log(
          JSON.stringify({
            level: "info",
            msg: "dataset_upgraded",
            rootCid: outcome.pointer.rootCid,
          }),
        );
      }
    });
  }, REFRESH_INTERVAL_MS);
  refresh.unref();

  const shutdown = (): void => {
    clearInterval(refresh);
    server.close(() => {
      dataset.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (isEntryPoint) {
  main().catch((error: unknown) => {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "boot_failed",
        detail: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exit(1);
  });
}
