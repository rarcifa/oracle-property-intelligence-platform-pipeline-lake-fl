/* global location, getComputedStyle, Node, innerWidth, innerHeight, createImageBitmap, Blob, OffscreenCanvas */
import { URL } from "node:url";

/** Recorder-only paint checks. DOM text is not evidence that the app was painted. */
export function assertPaintSample(sample) {
  if (
    !Number.isSafeInteger(sample.pixels) ||
    sample.pixels <= 0 ||
    !Number.isSafeInteger(sample.brightPixels) ||
    !Number.isSafeInteger(sample.darkPixels) ||
    sample.brightPixels < 0 ||
    sample.darkPixels < 0 ||
    sample.brightPixels + sample.darkPixels > sample.pixels
  )
    throw new Error("Invalid recorder paint sample");
  if (
    sample.darkPixels / sample.pixels >= 0.98 &&
    sample.brightPixels < Math.max(20, Math.floor(sample.pixels * 0.0001))
  )
    throw new Error("Hosted preview painted a blacked-out frame");
}

/** Run in the app document, including during waits and interactions. */
function installDomPaintChecks({ origin }) {
  if (location.origin !== origin) return;
  const state = { armed: false, stopped: false, checks: 0, reported: new Set() };
  window.__oraclePreviewPaint = state;
  const report = (message) => {
    if (state.reported.has(message)) return;
    state.reported.add(message);
    void window.__oraclePreviewPaintFailure({ message, observedAt: new Date().toISOString() });
  };
  let lastOverlayCheck = -Infinity;
  function check(now) {
    if (state.stopped) return;
    const root = document.querySelector("#root");
    const heading = root?.querySelector("h1");
    if (heading?.textContent?.includes("Oracle Property Intelligence")) state.armed = true;
    if (state.armed) {
      state.checks += 1;
      if (!root?.textContent?.trim()) report("Hosted preview lost its painted app content");
      let opacity = 1;
      for (let element = root; element; element = element.parentElement) {
        const style = getComputedStyle(element);
        opacity *= Number(style.opacity);
        const brightness = /brightness\((\d*\.?\d+)(%)?\)/.exec(style.filter);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          opacity <= 0.02 ||
          (brightness && Number(brightness[1]) / (brightness[2] ? 100 : 1) <= 0.02)
        )
          report("Hosted preview app became invisible or blacked out by CSS");
      }
      // Also catch short-lived opaque fixed overlays, including pointer-events:none.
      // Hit-testing alone would miss those overlays even though their paint hides the app.
      if (now - lastOverlayCheck >= 100) {
        lastOverlayCheck = now;
        for (const element of document.querySelectorAll("body *")) {
          if (element.contains(heading)) continue;
          const style = getComputedStyle(element);
          if (style.position !== "fixed" || style.visibility !== "visible") continue;
          const color = /^rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?\)$/.exec(
            style.backgroundColor,
          );
          if (
            !color ||
            Math.max(Number(color[1]), Number(color[2]), Number(color[3])) > 32 ||
            Number(color[4] ?? 1) * Number(style.opacity) < 0.98 ||
            Number(style.zIndex) < 0
          )
            continue;
          let overlayOpacity = 1;
          for (let ancestor = element; ancestor; ancestor = ancestor.parentElement)
            overlayOpacity *= Number(getComputedStyle(ancestor).opacity);
          if (Number(color[4] ?? 1) * overlayOpacity < 0.98) continue;
          const box = element.getBoundingClientRect();
          if (
            box.left <= 1 &&
            box.top <= 1 &&
            box.right >= innerWidth - 1 &&
            box.bottom >= innerHeight - 1 &&
            (Number(style.zIndex) > 0 ||
              Boolean(heading?.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING))
          )
            report("Hosted preview was covered by an opaque black overlay");
        }
      }
    }
    requestAnimationFrame(check);
  }
  requestAnimationFrame(check);
}

/** Sample actual screenshot pixels without another image library or browser stack. */
export async function startPaintMonitor(page, base, onFailure, intervalMs = 250) {
  const origin = new URL(base).origin;
  let stopped = false;
  let previousDomChecks = 0;
  const summary = {
    screenshotIntervalMs: intervalMs,
    domChecks: 0,
    screenshotSamples: 0,
    scope:
      "App-origin animation-frame CSS/overlay checks and sampled screenshot pixels; not exhaustive video-frame certification.",
  };
  const reported = new Set();
  const fail = (failure) => {
    if (reported.has(failure.message)) return;
    reported.add(failure.message);
    onFailure({ kind: "app paint failure", page: page.url(), ...failure });
  };
  await page.exposeBinding("__oraclePreviewPaintFailure", ({ frame }, failure) => {
    if (new URL(frame.url()).origin === origin) fail(failure);
  });
  await page.addInitScript(installDomPaintChecks, { origin });
  // Also support an already-open isolated test tab; production installs before navigation.
  if (new URL(page.url()).origin === origin) await page.evaluate(installDomPaintChecks, { origin });
  const loop = (async () => {
    while (!stopped) {
      try {
        if (new URL(page.url()).origin === origin) {
          const status = await page.evaluate(() => ({
            armed: window.__oraclePreviewPaint?.armed ?? false,
            checks: window.__oraclePreviewPaint?.checks ?? 0,
          }));
          summary.domChecks += Math.max(0, status.checks - previousDomChecks);
          previousDomChecks = status.checks;
          if (status.armed) {
            const png = await page.screenshot();
            const sample = await page.evaluate(
              async ({ bytes, origin }) => {
                if (location.origin !== origin || !window.__oraclePreviewPaint?.armed) return null;
                const image = await createImageBitmap(new Blob([new Uint8Array(bytes)]));
                const canvas = new OffscreenCanvas(image.width, image.height);
                const context = canvas.getContext("2d");
                context.drawImage(image, 0, 0);
                image.close();
                const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
                let darkPixels = 0;
                let brightPixels = 0;
                for (let index = 0; index < data.length; index += 4) {
                  const maximum = Math.max(data[index], data[index + 1], data[index + 2]);
                  if (maximum <= 32) darkPixels += 1;
                  if (maximum >= 40) brightPixels += 1;
                }
                return { pixels: canvas.width * canvas.height, darkPixels, brightPixels };
              },
              { bytes: Array.from(png), origin },
            );
            if (sample) {
              summary.screenshotSamples += 1;
              assertPaintSample(sample);
            }
          }
        }
      } catch (error) {
        // Document replacement during navigation is expected; an app paint-check
        // failure is not. Keep the monitor alive across route changes.
        if (
          !/Execution context was destroyed|Cannot find context|Target.*closed/.test(error.message)
        )
          fail({ message: error.message, observedAt: new Date().toISOString() });
      }
      if (!stopped) await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  })();
  return {
    snapshot() {
      return { ...summary };
    },
    async stop() {
      stopped = true;
      await loop;
      if (new URL(page.url()).origin === origin)
        await page.evaluate(() => {
          if (window.__oraclePreviewPaint) window.__oraclePreviewPaint.stopped = true;
        });
      return summary;
    },
  };
}
