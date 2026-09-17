import type { Page } from "@playwright/test";

export interface PaintFailure {
  kind: string;
  message: string;
  page: string;
  observedAt: string;
}

export function assertPaintSample(sample: {
  pixels: number;
  brightPixels: number;
  darkPixels: number;
}): void;

export function startPaintMonitor(
  page: Page,
  base: string,
  onFailure: (failure: PaintFailure) => void,
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
