// ─────────────────────────────────────────────────────────────────────────────
// index.ts — Entry point
//
// Flow:
//   1. Load config + structure definition
//   2. Launch browser, login
//   3. Scrape timesheet list
//   4. Fan-out parallel detail scraping
//   5. Write results + summary
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';

import beelineRaw from './parsers/structures/beeline_v1.json';
import type { VMSStructure } from './types';
import { newContext, newPage, closeBrowser } from './browser/browserManager';
import { login } from './auth/login';
import { scrapeTimesheetList } from './scrapers/timesheetList';
import { runAll } from './tasks/taskRunner';
import { writeResult, writeSummary } from './output/writer';
import { logger } from './utils/logger';
import { config } from './config';

// Cast: the JSON structure matches VMSStructure shape
const structure = beelineRaw as unknown as VMSStructure;

// ── Graceful shutdown ─────────────────────────────────────────────────────────

process.on('SIGINT', async () => {
  logger.warn('Interrupted — shutting down browser…');
  await closeBrowser();
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason });
});

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  logger.info('╔══════════════════════════════════════╗');
  logger.info('║   VMS Timesheet Scraper  —  POC      ║');
  logger.info('╚══════════════════════════════════════╝');
  logger.info(`Target     : ${config.beeline.url}`);
  logger.info(`Concurrency: ${config.scraper.maxConcurrency}`);
  logger.info(`Threshold  : ${config.scraper.confidenceThreshold * 100}%`);
  logger.info(`Output dir : ${config.output.root}`);

  const context = await newContext();

  // ── Login ──────────────────────────────────────────────────────────────────
  // Use a dedicated page for login + list scraping; detail pages get their own
  const { page: authPage } = await newPage(context);
  try {
    await login(authPage, structure);
  } catch (err) {
    logger.error('Login failed — aborting', {
      error: err instanceof Error ? err.message : err,
    });
    await closeBrowser();
    process.exit(1);
  }

  // ── Discover timesheets ────────────────────────────────────────────────────
  let items;
  try {
    items = await scrapeTimesheetList(authPage, structure);
  } catch (err) {
    logger.error('Failed to scrape timesheet list', {
      error: err instanceof Error ? err.message : err,
    });
    await closeBrowser();
    process.exit(1);
  } finally {
    await authPage.close().catch(() => undefined);
  }

  if (items.length === 0) {
    logger.warn('No timesheets found. Check DATE_FROM/DATE_TO filters or list selectors in beeline_v1.json.');
    await closeBrowser();
    return;
  }

  logger.info(`Discovered ${items.length} timesheets — starting detail extraction…`);

  // ── Parallel detail scraping ───────────────────────────────────────────────
  const { passed, failed } = await runAll(context, items, structure);

  // ── Write output ───────────────────────────────────────────────────────────
  logger.info('Writing JSON output…');
  await Promise.all(passed.map((r) => writeResult(r)));
  await writeSummary(passed, failed);

  await closeBrowser();
  logger.info('Done. ✓');
}

main();
