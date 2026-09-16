import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mergePermitWindow } from "../scripts/lake/fetch-sources.mjs";

const directories: string[] = [];
async function fixture(records: unknown): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "lake-incremental-base-"));
  directories.push(directory);
  const basePath = path.join(directory, "permits.json");
  await writeFile(basePath, JSON.stringify(records));
  return basePath;
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("isolated incremental permit base", () => {
  it("preserves untouched records and multiple parcel associations, without changing the base", async () => {
    const original = [
      { permit_number: "a", alternate_key: "1", permit_status: "ISSUED" },
      { permit_number: "a", alternate_key: "2", permit_status: "ISSUED" },
      { permit_number: "b", alternate_key: "3", permit_status: "FINAL" },
    ];
    const basePath = await fixture(original);
    const delta = [
      { permit_number: "a", alternate_key: "1", permit_status: "FINAL" },
      { permit_number: "c", alternate_key: "4", permit_status: "ISSUED" },
    ];
    const merged = await mergePermitWindow(delta, { basePath });
    expect(merged).toEqual([delta[0], original[1], original[2], delta[1]]);
    expect(JSON.parse(await readFile(basePath, "utf8"))).toEqual(original);
    const laterBase = await fixture(merged);
    expect(await mergePermitWindow(delta, { basePath: laterBase })).toEqual(merged);
  });

  it("fails closed instead of presenting a window without a base as countywide", async () => {
    const emptyDirectory = await mkdtemp(path.join(tmpdir(), "lake-missing-base-"));
    directories.push(emptyDirectory);
    await expect(
      mergePermitWindow([], { basePath: path.join(emptyDirectory, "missing.json") }),
    ).rejects.toThrow();
    await expect(mergePermitWindow([], { basePath: await fixture({}) })).rejects.toThrow(
      /must be an array/,
    );
    await expect(
      mergePermitWindow([], { basePath: await fixture([{ permit_number: "" }]) }),
    ).rejects.toThrow(/stable permit number/);
  });
});
