/**
 * The `/api/chat` route.
 *
 * A missing `OPENAI_API_KEY` is a 503 with an explanation, never a boot
 * failure and never a crash: the data surfaces must keep working without a
 * model key.
 */

import { chatRequestSchema } from "@oracle-lake/shared";
import type { AppContext } from "../context.js";
import { sanitizeProviderError, ChatUnavailableError, createChatAgent } from "../chat/agent.js";
import { callerOf, createRateLimiter, DEFAULT_CHAT_RATE_LIMIT } from "../chat/rate-limit.js";
import { fail, json, type Router } from "../http/router.js";

/** Register the chat route. */
export function registerChatRoutes(router: Router, context: AppContext): void {
  const agent = createChatAgent(context);
  // The only endpoint here that spends money per call, on a public URL.
  const limiter = createRateLimiter(DEFAULT_CHAT_RATE_LIMIT);

  router.post("/api/chat", async (request) => {
    if (!agent.enabled) {
      return fail(
        503,
        "chat_unavailable",
        "OPENAI_API_KEY is not set on the server, so the natural-language agent is disabled. Every other view queries the published data directly and is unaffected.",
      );
    }
    // Identify the caller as well as a Function URL allows. `x-forwarded-for`
    // is client-supplied and spoofable, so this bounds honest traffic and cost
    // rather than defeating a determined attacker — worth saying plainly.
    const verdict = limiter.take(callerOf(request.headers));
    if (!verdict.allowed) {
      return fail(
        429,
        "rate_limited",
        `This endpoint calls a paid model, so it is rate limited per caller. Try again in ${verdict.retryAfterSeconds}s. Every other view queries the published data directly and is not limited.`,
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
      // Log the real error for the operator; tell the caller only what is
      // theirs to know. This route is public and unauthenticated.
      const detail = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ event: "chat_failed", detail }));
      return fail(502, "chat_failed", sanitizeProviderError(detail));
    }
  });
}
