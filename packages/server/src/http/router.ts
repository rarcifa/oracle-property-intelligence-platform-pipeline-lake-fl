/**
 * A minimal request router.
 *
 * Handlers take a normalised request object and return a plain response object,
 * which means every route is unit-testable without opening a socket. The
 * `node:http` adapter in `index.ts` is the only place that touches streams.
 */

export interface HttpRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  /** Parsed JSON body for requests that carried one. */
  body: unknown;
  /** Values captured from the route pattern, e.g. `:parcelId`. */
  params: Record<string, string>;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string | Uint8Array;
}

export type Handler = (request: HttpRequest) => Promise<HttpResponse> | HttpResponse;

/** JSON response helper. */
export function json(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): HttpResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
    body: JSON.stringify(payload),
  };
}

/** Error response with a stable shape the UI renders directly. */
export function fail(status: number, error: string, detail?: string): HttpResponse {
  return json(status, detail === undefined ? { error } : { error, detail });
}

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

export class Router {
  readonly #routes: Route[] = [];

  #fallback: Handler | null = null;

  /** Register a route. `:name` segments are captured into `request.params`. */
  add(method: string, pattern: string, handler: Handler): this {
    this.#routes.push({
      method: method.toUpperCase(),
      segments: pattern.split("/").filter((segment) => segment.length > 0),
      handler,
    });
    return this;
  }

  get(pattern: string, handler: Handler): this {
    return this.add("GET", pattern, handler);
  }

  post(pattern: string, handler: Handler): this {
    return this.add("POST", pattern, handler);
  }

  /** Handler used when nothing matched, e.g. the SPA static handler. */
  fallback(handler: Handler): this {
    this.#fallback = handler;
    return this;
  }

  /** Resolve and run the matching handler. */
  async handle(request: Omit<HttpRequest, "params">): Promise<HttpResponse> {
    const method = request.method.toUpperCase();
    const segments = request.path.split("/").filter((segment) => segment.length > 0);
    let pathMatchedAnotherMethod = false;

    for (const route of this.#routes) {
      if (route.segments.length !== segments.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let index = 0; index < route.segments.length; index += 1) {
        const pattern = route.segments[index] as string;
        const actual = segments[index] as string;
        if (pattern.startsWith(":")) {
          params[pattern.slice(1)] = decodeURIComponent(actual);
        } else if (pattern !== actual) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;
      if (route.method !== method) {
        pathMatchedAnotherMethod = true;
        continue;
      }
      return route.handler({ ...request, params });
    }

    if (pathMatchedAnotherMethod) {
      return fail(405, "method_not_allowed", `${method} is not allowed on ${request.path}`);
    }
    if (this.#fallback) return this.#fallback({ ...request, params: {} });
    return fail(404, "not_found", `No route for ${method} ${request.path}`);
  }
}
