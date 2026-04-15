import type { BrowserContext, Page } from 'playwright';
import type { VMSStructure, ScrapeResult, TimesheetListItem, TimesheetData } from '../types';
import { newPage } from '../browser/browserManager';
import { withRetry } from '../utils/retry';
import { logger } from '../utils/logger';
import { AsyncQueue } from './taskQueue';
import { config } from '../config';

type ScraperFn = (page: Page, item: TimesheetListItem) => Promise<TimesheetData>;
type OnResultFn = (result: ScrapeResult) => Promise<void>;

class Progress {
  private done = 0;
  private startMs = Date.now();
  constructor(private total: number) { }
  tick(id: string, ok: boolean) {
    this.done++;
    const pct = Math.round((this.done / this.total) * 100);
    const secs = ((Date.now() - this.startMs) / 1000).toFixed(1);
    const avg = (parseFloat(secs) / this.done).toFixed(1);
    const rem = ((this.total - this.done) * parseFloat(avg)).toFixed(0);
    logger.info(`${ok ? '✓' : '✗'} [${this.done}/${this.total} ${pct}%] ${id} — ${secs}s elapsed, ~${rem}s left`);
  }
}

async function processOne(
  context: BrowserContext,
  item: TimesheetListItem,
  scraperFn: ScraperFn,
  onResult?: OnResultFn,
  progress?: Progress,
): Promise<ScrapeResult> {
  const result = await withRetry(
    async (attempt) => {
      const { page } = await newPage(context);
      try {
        const data = await scraperFn(page, item);
        return {
          success: true, data,
          timesheetId: item.timesheetId,
          url: item.url, attempts: attempt,
        } satisfies ScrapeResult;
      } finally {
        await page.close().catch(() => undefined);
      }
    },
    { maxAttempts: config.scraper.maxRetries, baseDelayMs: 2_000, label: item.timesheetId },
  ).catch((err): ScrapeResult => ({
    success: false,
    error: err instanceof Error ? err.message : String(err),
    timesheetId: item.timesheetId,
    url: item.url, attempts: config.scraper.maxRetries,
  }));

  // Write immediately — do not wait for other tasks to finish
  progress?.tick(result.timesheetId, result.success);
  if (result.success && onResult) {
    await onResult(result).catch((e) =>
      logger.error(`Write failed for ${result.timesheetId}: ${(e as Error).message}`)
    );
  }

  return result;
}

export async function runAll(
  context: BrowserContext,
  items: TimesheetListItem[],
  _structure: VMSStructure | null,
  scraperFn: ScraperFn,
  onResult?: OnResultFn,
): Promise<{ passed: ScrapeResult[]; failed: ScrapeResult[] }> {
  logger.info(`Starting: ${items.length} timesheets, concurrency=${config.scraper.maxConcurrency}`);

  const queue = new AsyncQueue<ScrapeResult>(config.scraper.maxConcurrency);
  const progress = new Progress(items.length);
  const passed: ScrapeResult[] = [];
  const failed: ScrapeResult[] = [];

  const settled = await Promise.allSettled(
    items.map((item) =>
      queue.add(() => processOne(context, item, scraperFn, onResult, progress))
    )
  );

  for (const outcome of settled) {
    if (outcome.status === 'fulfilled') {
      outcome.value.success ? passed.push(outcome.value) : failed.push(outcome.value);
    }
  }

  logger.info(`═══ ✓ ${passed.length} passed | ✗ ${failed.length} failed ═══`);
  return { passed, failed };
}