import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import {
  startPaintMonitor,
  type PaintFailure,
  type PaintDiagnostic,
} from "../../scripts/record-preview-paint.mjs";

const BASE = "http://127.0.0.1:54973";
const HTML = `<!doctype html><style>
  body { margin:0; background:#080b10; color:#e9edf2; font:16px sans-serif }
  #root { min-height:100vh; padding:24px; box-sizing:border-box }
  h1 { font-size:22px }
</style><div id="root"><h1>Oracle Property Intelligence</h1>
  <p>SYNTHETIC RECORDER PAINT FIXTURE. Not runtime or publication evidence.</p>
  <button>Still interactive</button></div>`;

test.beforeEach(async ({ page }) => {
  await page.route("**/*", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: HTML }),
  );
});

for (const fault of ["root-opacity", "root-brightness", "black-overlay", "paint-only-black"]) {
  test(`rejects a transient ${fault} while DOM text survives`, async ({ page }) => {
    const failures: PaintFailure[] = [];
    const monitor = await startPaintMonitor(
      page,
      BASE,
      (failure) => {
        failures.push(failure);
      },
      50,
    );
    try {
      await page.goto(BASE);
      await expect(
        page.getByRole("heading", { name: "Oracle Property Intelligence" }),
      ).toBeVisible();
      // Capture the healthy app first, then inject a visual-only fault during interaction.
      await expect.poll(() => monitor.snapshot().screenshotSamples).toBeGreaterThan(0);
      await page.evaluate((fault) => {
        const root = document.getElementById("root")!;
        if (fault === "root-opacity") root.style.opacity = "0";
        else if (fault === "root-brightness") root.style.filter = "brightness(0)";
        else if (fault === "paint-only-black") {
          // A full-screen black SVG has transparent CSS background, so pixel
          // sampling, not the opaque-background DOM check, must catch it.
          const image = document.createElement("img");
          image.id = "fault";
          image.src =
            'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="black"/></svg>';
          image.style.cssText =
            "position:fixed;inset:0;width:100vw;height:100vh;z-index:9999;pointer-events:none";
          document.body.append(image);
        } else {
          const overlay = document.createElement("div");
          overlay.id = "fault";
          overlay.style.cssText =
            "position:fixed;inset:0;background:black;z-index:9999;pointer-events:none";
          document.body.append(overlay);
        }
      }, fault);
      await expect.poll(() => failures.length).toBeGreaterThan(0);
      // Restore it before teardown. Detection must survive a transient fault,
      // not just find an app that remained black until the final check.
      await page.evaluate(() => {
        document.getElementById("root")!.style.cssText = "";
        document.getElementById("fault")?.remove();
      });
      expect(await page.locator("#root").innerText()).toContain("Still interactive");
      if (fault === "paint-only-black")
        expect(failures.some((failure) => failure.message.includes("blacked-out frame"))).toBe(
          true,
        );
    } finally {
      await monitor.stop();
    }
  });
}

test("accepts the healthy dark design and stops checking other public origins", async ({
  page,
}) => {
  const failures: PaintFailure[] = [];
  const monitor = await startPaintMonitor(
    page,
    BASE,
    (failure) => {
      failures.push(failure);
    },
    50,
  );
  await page.goto(BASE);
  await expect(page.getByRole("heading", { name: "Oracle Property Intelligence" })).toBeVisible();
  await expect.poll(() => monitor.snapshot().screenshotSamples).toBeGreaterThan(0);
  await page.goto("https://public-gateway.example.invalid/ipfs/synthetic");
  const summary = await monitor.stop();
  expect(failures).toEqual([]);
  expect(summary.scope).toContain("not exhaustive video-frame certification");
});

test("does not mistake an invisible overlay descendant for black paint", async ({ page }) => {
  const failures: PaintFailure[] = [];
  const monitor = await startPaintMonitor(
    page,
    BASE,
    (failure) => {
      failures.push(failure);
    },
    50,
  );
  try {
    await page.goto(BASE);
    await expect.poll(() => monitor.snapshot().screenshotSamples).toBeGreaterThan(0);
    await page.evaluate(() => {
      const invisible = document.createElement("div");
      invisible.style.opacity = "0";
      const overlay = document.createElement("div");
      overlay.style.cssText = "position:fixed;inset:0;background:black;z-index:9999";
      invisible.append(overlay);
      document.body.append(invisible);
    });
    await expect.poll(() => monitor.snapshot().screenshotSamples).toBeGreaterThan(3);
    expect(failures).toEqual([]);
  } finally {
    await monitor.stop();
  }
});

test("preserves the exact failed sampled PNG and capture context before stopping", async ({
  page,
}, testInfo) => {
  const failures: PaintFailure[] = [];
  const diagnostics: PaintDiagnostic[] = [];
  const savedPath = testInfo.outputPath("synthetic-failed-paint.png");
  const monitor = await startPaintMonitor(
    page,
    BASE,
    async (failure, diagnostic) => {
      failures.push(failure);
      if (diagnostic) {
        diagnostics.push(diagnostic);
        await writeFile(savedPath, diagnostic.png);
      }
    },
    50,
  );
  try {
    await page.goto(BASE);
    await expect.poll(() => monitor.snapshot().screenshotSamples).toBeGreaterThan(0);
    await page.evaluate(() => {
      const image = document.createElement("img");
      image.src =
        'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="black"/></svg>';
      image.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;z-index:9999";
      document.body.append(image);
    });
    await expect.poll(() => diagnostics.length).toBe(1);
  } finally {
    await monitor.stop();
  }
  const diagnostic = diagnostics[0]!;
  const saved = await readFile(savedPath);
  expect(saved.equals(Buffer.from(diagnostic.png))).toBe(true);
  expect(createHash("sha256").update(saved).digest("hex")).toBe(diagnostic.pngSha256);
  expect([...saved.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(diagnostic.sample.darkPixels / diagnostic.sample.pixels).toBeGreaterThanOrEqual(0.98);
  expect(Date.parse(diagnostic.captureFinishedAt)).toBeGreaterThanOrEqual(
    Date.parse(diagnostic.captureStartedAt),
  );
  expect(diagnostic.contextRecordedAt).toBeTruthy();
  expect(diagnostic.context?.root?.textCharacters).toBeGreaterThan(0);
  expect(diagnostic.context?.url).toBe(BASE + "/");
  expect(failures.some((failure) => failure.message.includes("blacked-out frame"))).toBe(true);
});
