import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, gzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import { sha256Text } from "../src/batch/contracts.js";
import type {
  ClermontImmutableArtifact,
  ClermontPartitionHandoff,
} from "../src/batch/clermont-contracts.js";
import {
  iterateEvidenceLines,
  verifyClermontEvidenceCorrelation,
} from "../src/batch/clermont-executor.js";

const execFileAsync = promisify(execFile);
const scratchRoots: string[] = [];

async function scratch(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "clermont-evidence-stream-"));
  scratchRoots.push(root);
  return root;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function artifact(root: string, logicalPath: string): Promise<ClermontImmutableArtifact> {
  const filePath = path.join(root, logicalPath);
  const fileStat = await stat(filePath);
  return {
    logicalPath,
    sha256: await sha256File(filePath),
    bytes: fileStat.size,
  };
}

async function collect(root: string, value: ClermontImmutableArtifact): Promise<unknown[]> {
  const values: unknown[] = [];
  for await (const entry of iterateEvidenceLines(root, value)) values.push(entry);
  return values;
}

afterEach(async () => {
  await Promise.all(
    scratchRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("streaming Clermont evidence", () => {
  it("decodes UTF-8 split across stream chunks and closes after an early return", async () => {
    const root = await scratch();
    const logicalPath = "utf8.ndjson";
    const filePath = path.join(root, logicalPath);
    const body = `${"x".repeat(65_530)}🙂tail`;
    await writeFile(
      filePath,
      `${JSON.stringify({ body })}\n${JSON.stringify({ body: "unused" })}\n`,
    );
    const descriptor = await artifact(root, logicalPath);

    const iterator = iterateEvidenceLines(root, descriptor);
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { body } });
    await iterator.return(undefined);
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });

    const renamed = path.join(root, "closed.ndjson");
    await rename(filePath, renamed);
    await expect(readFile(renamed, "utf8")).resolves.toContain("unused");
  });

  it("fails closed for digest drift, truncated gzip, and malformed NDJSON", async () => {
    const root = await scratch();
    await writeFile(path.join(root, "valid.ndjson.gz"), gzipSync('{"ok":true}\n'));
    const valid = await artifact(root, "valid.ndjson.gz");
    await expect(collect(root, { ...valid, sha256: "0".repeat(64) })).rejects.toThrow(
      /failed digest readback/,
    );

    const compressed = gzipSync('{"ok":true}\n');
    await writeFile(path.join(root, "truncated.ndjson.gz"), compressed.subarray(0, -4));
    const truncated = await artifact(root, "truncated.ndjson.gz");
    await expect(collect(root, truncated)).rejects.toThrow();

    await writeFile(path.join(root, "malformed.ndjson.gz"), gzipSync('{"ok":true}\nnot-json\n'));
    const malformed = await artifact(root, "malformed.ndjson.gz");
    await expect(collect(root, malformed)).rejects.toThrow(/at line 2/);
  });

  it("rejects duplicate evidence identities without retaining raw bodies", async () => {
    const root = await scratch();
    const stableId = "lake:clermont:etrakit:15-0001";
    const body = "<html>permit</html>";
    const wrapper = { stableId, mediaType: "text/html", sha256: sha256Text(body), body };
    await writeFile(
      path.join(root, "raw.ndjson.gz"),
      gzipSync(`${JSON.stringify(wrapper)}\n${JSON.stringify(wrapper)}\n`),
    );
    await writeFile(path.join(root, "extracted.ndjson.gz"), gzipSync(""));
    await writeFile(path.join(root, "status.ndjson.gz"), gzipSync(""));
    const directory =
      '<html><select name="ddlSelContractor"><option value="CCC000000">EXAMPLE ROOFING</option></select></html>\n';
    await writeFile(path.join(root, "license-directory.html"), directory);

    const handoff = {
      year: 2015,
      artifacts: {
        raw: await artifact(root, "raw.ndjson.gz"),
        extracted: await artifact(root, "extracted.ndjson.gz"),
        status: await artifact(root, "status.ndjson.gz"),
        licenseDirectory: await artifact(root, "license-directory.html"),
      },
      licenseDirectory: { sha256: sha256Text(directory), entries: 1 },
    } as ClermontPartitionHandoff;

    await expect(
      verifyClermontEvidenceCorrelation({ candidateRoot: root, handoff }),
    ).rejects.toThrow(`Duplicate raw wrapper for ${stableId}`);
  });

  it("streams an archive larger than the child heap", async () => {
    const root = await scratch();
    const logicalPath = "larger-than-heap.ndjson.gz";
    const filePath = path.join(root, logicalPath);
    const rows = 262_144;
    const padding = "x".repeat(1_024);
    async function* source(): AsyncGenerator<string> {
      for (let index = 0; index < rows; index += 1) {
        yield `${JSON.stringify({ index, padding })}\n`;
      }
    }
    await pipeline(Readable.from(source()), createGzip({ level: 1 }), createWriteStream(filePath));
    const descriptor = await artifact(root, logicalPath);
    const childPath = path.join(root, "reader.mts");
    const executorUrl = pathToFileURL(
      path.resolve(process.cwd(), "src/batch/clermont-executor.ts"),
    ).href;
    await writeFile(
      childPath,
      [
        `import { iterateEvidenceLines } from ${JSON.stringify(executorUrl)};`,
        `const root = ${JSON.stringify(root)};`,
        `const descriptor = ${JSON.stringify(descriptor)};`,
        "let count = 0;",
        "for await (const _value of iterateEvidenceLines(root, descriptor)) count += 1;",
        "process.stdout.write(String(count));",
      ].join("\n"),
    );
    const loaderPath = path.resolve(process.cwd(), "node_modules/tsx/dist/loader.mjs");
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--max-old-space-size=128", "--import", loaderPath, childPath],
      { cwd: process.cwd(), maxBuffer: 1_024 * 1_024, timeout: 120_000 },
    );
    expect(stdout).toBe(String(rows));
  }, 180_000);
});
