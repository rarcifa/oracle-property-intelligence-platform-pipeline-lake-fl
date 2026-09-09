/**
 * Where the committed index lives.
 *
 * Its own module so the query path can resolve the file without importing the
 * builder, which reaches for YAML parsing and the repository tree that no
 * request-time code needs.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Package root, resolved from either `src/index` or `dist/index`. */
export const PACKAGE_ROOT = resolve(here, "../..");

/** The committed index. Not under `data/`, which is gitignored. */
export const INDEX_PATH = resolve(PACKAGE_ROOT, "index-data/lake-rag-index.json");
