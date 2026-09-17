import type { Page } from "@playwright/test";

export function historicalRowCells(row: Record<string, unknown>): string[];
export function assertHistoricalRowsDisplayed(
  page: Page,
  rows: Record<string, unknown>[],
  timeout?: number,
): Promise<{ renderedRowsVerified: number; columnsVerified: number }>;

export function frameHistoricalTableStart(
  page: Page,
  firstRow: Record<string, unknown>,
  timeout?: number,
): Promise<{
  firstPermitNumber: string;
  tableHeaderInViewport: true;
  firstRowInViewport: true;
}>;
