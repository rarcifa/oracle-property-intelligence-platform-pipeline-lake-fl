/**
 * The `/api/chat` route.
 *
 * A missing `ANTHROPIC_API_KEY` is a 503 with an explanation, never a boot
 * failure and never a crash: the data surfaces must keep working without a
 * model key.
 */

import { chatRequestSchema } from "@oracle-lake/shared";
import type { AppContext } from "../context.js";
import { ChatUnavailableError, createChatAgent } from "../chat/agent.js";
import { fail, json, type Router } from "../http/router.js";

/** Register the chat route. */
export function registerChatRoutes(router: Router, context: AppContext): void {
  const agent = createChatAgent(context);

  router.post("/api/chat", async (request) => {
    if (!agent.enabled) {
      return fail(
        503,
        "chat_unavailable",
        "ANTHROPIC_API_KEY is not set on the server, so the natural-language agent is disabled. Every other view queries the published data directly and is unaffected.",
      );
    }
    const parsed = chatRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return fail(
        400,
        "invalid_body",
        parsed.error.issues.map((issue) => issue.message).join("; "),
      );
    }
    try {
      return json(200, await agent.run(parsed.data.messages));
    } catch (error) {
      if (error instanceof ChatUnavailableError) {
        return fail(503, "chat_unavailable", error.detail);
      }
      const detail = error instanceof Error ? error.message : String(error);
      return fail(502, "chat_failed", detail);
    }
  });
}
