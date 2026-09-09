/**
 * Static file serving for the built single-page app.
 *
 * The server serves the UI and the API from one process on one port, which is
 * what makes the whole application deployable behind a single URL. Unknown
 * paths that are not API paths fall through to `index.html` so client-side hash
 * routing works on a cold load.
 */

import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fail, type Handler, type HttpResponse } from "./router.js";

const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
});

function contentType(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

async function readIfFile(path: string): Promise<Uint8Array | null> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    return await readFile(path);
  } catch {
    return null;
  }
}

/**
 * Build the SPA fallback handler.
 *
 * `distDir` may not exist yet (the UI has not been built), in which case the
 * handler explains how to build it rather than 404-ing blankly.
 */
export function createStaticHandler(distDir: string): Handler {
  const root = resolve(distDir);

  return async (request): Promise<HttpResponse> => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return fail(405, "method_not_allowed");
    }
    if (request.path.startsWith("/api/") || request.path === "/mcp") {
      return fail(404, "not_found", `No route for ${request.method} ${request.path}`);
    }

    const relative = normalize(request.path)
      .replace(/^(\.\.[/\\])+/, "")
      .replace(/^[/\\]+/, "");
    const candidate = resolve(join(root, relative));
    // Refuse anything that escaped the dist directory.
    const inRoot = candidate === root || candidate.startsWith(root + sep);

    if (inRoot && relative.length > 0) {
      const file = await readIfFile(candidate);
      if (file !== null) {
        const immutable = /\/assets\//.test(request.path);
        return {
          status: 200,
          headers: {
            "content-type": contentType(candidate),
            "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
          },
          body: file,
        };
      }
    }

    const index = await readIfFile(join(root, "index.html"));
    if (index === null) {
      return fail(
        503,
        "ui_not_built",
        `No built UI at ${root}. Run "pnpm run build" from the repository root, then restart the server.`,
      );
    }
    return {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
      body: index,
    };
  };
}
