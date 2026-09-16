import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as dagPB from "@ipld/dag-pb";
import { describe, expect, it } from "vitest";
import { buildRunDag } from "../scripts/lake/publish-run.mjs";

describe("directory inventory closure", () => {
  it("retains every ancestor of deeply nested eligible files", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "lake-directory-dag-"));
    try {
      await mkdir(path.join(directory, "a", "b"), { recursive: true });
      await writeFile(path.join(directory, "a", "b", "rows.json"), "{}\n");
      const dag = await buildRunDag(directory);
      expect(dag.entries.map((entry: { name: string }) => entry.name).sort()).toEqual([
        "/",
        "a/",
        "a/b/",
        "a/b/rows.json",
      ]);
      const rootBlock = dag.blocks.find(
        (block: { cid: string }) => String(block.cid) === dag.rootCid,
      )!;
      expect(dagPB.decode(rootBlock.bytes).Links.map((link) => link.Name)).toEqual(["a"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
