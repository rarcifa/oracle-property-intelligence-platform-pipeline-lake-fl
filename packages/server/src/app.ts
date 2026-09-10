/**
 * Composition root: one router carrying all three surfaces on one port.
 *
 * `/api/*` is the REST API, `/mcp` is the stateless MCP endpoint, `/api/chat`
 * is the agent, and everything else falls through to the built single-page app.
 * One process, one URL, one DuckDB connection behind all of it.
 */

import type { AppContext } from "./context.js";
import { createStaticHandler } from "./http/static.js";
import { fail, json, Router, type HttpResponse } from "./http/router.js";
import { handleRpcPayload } from "./mcp/server.js";
import { registerApiRoutes } from "./routes/api.js";
import { registerChatRoutes } from "./routes/chat.js";

/** Build the fully wired router. */
export function createApp(context: AppContext): Router {
  const router = new Router();

  registerApiRoutes(router, context);
  registerChatRoutes(router, context);

  router.post("/mcp", async (request): Promise<HttpResponse> => {
    if (request.body === undefined || request.body === null) {
      return json(400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error: expected a JSON-RPC 2.0 body" },
      });
    }
    const response = await handleRpcPayload(context, request.body);
    if (response === null) {
      // A notification-only payload gets no body.
      return { status: 202, headers: {}, body: "" };
    }
    return json(200, response);
  });

  // A GET on /mcp is answered with the endpoint's own description rather than a
  // 405, because that is what a human pointing a browser at it needs.
  router.get("/mcp", () =>
    json(200, {
      transport: "http",
      protocol: "jsonrpc-2.0",
      stateless: true,
      usage: "POST a JSON-RPC 2.0 message to this URL. Start with the `initialize` method.",
    }),
  );

  router.fallback(createStaticHandler(context.config.uiDist));

  return router;
}

export { fail, json };
