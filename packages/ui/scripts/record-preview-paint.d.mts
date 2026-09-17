import type { Page } from "@playwright/test";

export interface PaintFailure {
  kind: string;
  message: string;
  page: string;
  observedAt: string;
}

export interface PaintDiagnostic {
  png: Uint8Array;
  pngSha256: string;
  sample: { pixels: number; brightPixels: number; darkPixels: number };
  captureStartedAt: string;
  captureFinishedAt: string;
  contextRecordedAt: string;
  context: {
    url: string;
    scrollX: number;
    scrollY: number;
    viewportWidth: number;
    viewportHeight: number;
    root: PaintElementContext | null;
    header: PaintElementContext | null;
  } | null;
  contextError: string | null;
}

interface PaintElementContext {
  rect: { x: number; y: number; width: number; height: number };
  opacity: string;
  display: string;
  visibility: string;
  filter: string;
  textCharacters: number;
}

export function assertPaintSample(sample: {
  pixels: number;
  brightPixels: number;
  darkPixels: number;
}): void;

export function startPaintMonitor(
  page: Page,
  base: string,
  onFailure: (failure: PaintFailure, diagnostic?: PaintDiagnostic) => void | Promise<void>,
  intervalMs?: number,
): Promise<{
  snapshot(): {
    screenshotIntervalMs: number;
    domChecks: number;
    screenshotSamples: number;
    scope: string;
  };
  stop(): Promise<{
    screenshotIntervalMs: number;
    domChecks: number;
    screenshotSamples: number;
    scope: string;
  }>;
}>;
