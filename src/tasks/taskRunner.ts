// ─────────────────────────────────────────────────────────────────────────────
// tasks/taskRunner.ts — Parallel orchestration with retry + concurrency cap
// ─────────────────────────────────────────────────────────────────────────────

import type { BrowserContext } from 'playwright';
import type { VMSStructure, ScrapeResult, TimesheetListItem } from '../types';
import { newPage } from '../browser/browserManager';
import { scrapeTimesheetDetail } from '../scrapers/timesheetDetail';
import { withRetry } from '../utils/retry';
import { logger } from '../utils/logger';
import { AsyncQueue } from './taskQueue';
import { config } from '../config';

// ── Progress tracker ──────────────────────────────────────────────────────────

class Progress {
  private total: number;
  private done = 0;
  private startMs = Date.now();

  constructor(total: number) {
    this.total = total;
  }

  tick(timesheetId: string, success: boolean): void {
    this.done++;
    const pct = Math.round((this.done / this.total) * 100);
    const elapsedSec = ((Date.now() - this.startMs) / 1000).toFixed(1);
    const avgSec = (parseFloat(elapsedSec) / this.done).toFixed(1);
    const remaining = ((this.total - this.done) * parseFloat(avgSec)).toFixed(0);
    const icon = success ? '✓' : '✗';

    logger.info(
      `${icon} [${this.done}/${this.total} | ${pct}%] ${timesheetId} — ` +
      `elapsed: ${elapsedSec}s, ~${remaining}s remaining`,
    );
  }
}

// ── Single-timesheet worker ───────────────────────────────────────────────────

async function processOne(
  context: BrowserContext,
  item: TimesheetListItem,
  structure: VMSStructure,
): Promise<ScrapeResult> {
  return withRetry(
    async (attempt) => {
      logger.debug(`Opening page for ${item.timesheetId} (attempt ${attempt})`);

      const { page } = await newPage(context);
      try {
        const data = await scrapeTimesheetDetail(page, item, structure);
        return {
          success: true,
          data,
          timesheetId: item.timesheetId,
          url: item.url,
          attempts: attempt,
        } satisfies ScrapeResult;
      } finally {
        // Always close the page — never leak browser tabs
        await page.close().catch(() => undefined);
      }
    },
    {
      maxAttempts: config.scraper.maxRetries,
      baseDelayMs: 2_000,
      label: item.timesheetId,
    },
  ).catch((err): ScrapeResult => ({
    success: false,
    error: err instanceof Error ? err.message : String(err),
    timesheetId: item.timesheetId,
    url: item.url,
    attempts: config.scraper.maxRetries,
  }));
}

// ── Public runner ─────────────────────────────────────────────────────────────

export async function runAll(
  authContext: BrowserContext,
  items: TimesheetListItem[],
  structure: VMSStructure,
): Promise<{ passed: ScrapeResult[]; failed: ScrapeResult[] }> {
  logger.info(
    `Starting parallel scrape: ${items.length} timesheets, ` +
    `concurrency=${config.scraper.maxConcurrency}`,
  );

  const queue = new AsyncQueue<ScrapeResult>(config.scraper.maxConcurrency);
  const progress = new Progress(items.length);
  const passed: ScrapeResult[] = [];
  const failed: ScrapeResult[] = [];

  const tasks = items.map((item) =>
    queue.add(() => processOne(authContext, item, structure)),
  );

  // Stream results as they complete (don't wait for all)
  const settled = await Promise.allSettled(tasks);

  for (const outcome of settled) {
    // allSettled won't reject — processOne catches internally
    const result = outcome.status === 'fulfilled'
      ? outcome.value
      : {
          success: false as const,
          timesheetId: 'unknown',
          url: '',
          attempts: 0,
          error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
        };

    progress.tick(result.timesheetId, result.success);

    if (result.success) {
      passed.push(result);
    } else {
      failed.push(result);
      logger.error(`FAILED: ${result.timesheetId} — ${result.error}`);
    }
  }

  logger.info(`═══ Run complete ═══ ✓ ${passed.length} passed | ✗ ${failed.length} failed`);
  return { passed, failed };
}
