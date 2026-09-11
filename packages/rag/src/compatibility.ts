/** Fail-closed compatibility between a bundled corpus and served dataset bytes. */

import type { RagIndex } from "./types.js";

export interface ServedRunIdentity {
  runId: string | null;
  rootCid: string | null;
}

/**
 * Assert that document claims and row queries refer to the same immutable run.
 *
 * A local candidate is valid only beside local data (no root CID). Once a run
 * is published, the index must be rebuilt from a receipt that binds the public
 * CID; matching a run ID alone is intentionally insufficient.
 */
export function assertIndexCompatibleWithRun(index: RagIndex, served: ServedRunIdentity): void {
  if (served.runId === null) {
    throw new Error("The served dataset has no runId; document retrieval is disabled");
  }
  if (served.runId !== index.builtFrom.runId) {
    throw new Error(
      `RAG corpus run ${index.builtFrom.runId} does not match served run ${served.runId}`,
    );
  }

  if (index.builtFrom.releaseState === "local_candidate") {
    if (served.rootCid !== null) {
      throw new Error(
        `RAG corpus ${index.builtFrom.runId} is an unpublished local candidate but the served dataset has public root ${served.rootCid}`,
      );
    }
    return;
  }

  if (index.builtFrom.rootCid === null) {
    throw new Error(`Published RAG corpus ${index.builtFrom.runId} has no rootCid`);
  }
  if (served.rootCid !== index.builtFrom.rootCid) {
    throw new Error(
      `RAG corpus root ${index.builtFrom.rootCid} does not match served root ${served.rootCid ?? "none"}`,
    );
  }
}
