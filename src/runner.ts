// ─────────────────────────────────────────────────────────────────────────────
// runner.ts — Account runner with change detection + flag tracking
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import * as path                 from 'path';
import { logger }                from './utils/logger';
import { acquireLock, releaseLock } from './utils/runLock';
import { writeResult, writeSummary } from './output/writer';
import { runAll }                from './tasks/taskRunner';
import {
  createRun, updateRun, insertRecord,
  upsertFingerprint, markFingerprintScraped,
} from './db/database';
import { broadcastStatus, broadcastLog } from './server/websocket';
import { getAccount }            from './config/accountsConfig';
import { newContext, newPage }   from './browser/browserManager';
import type { ScrapeResult, TimesheetData } from './types';
import { loginFieldglass }        from './auth/fieldglassLogin';
import { scrapeFieldglassList, type FgListItem } from './scrapers/fieldglassListScraper';
import { scrapeFieldglassDetail } from './scrapers/fieldglassDetailScraper';

// ── Result writer — saves JSON + inserts to DB with flag ──────────────────────

function makeResultWriter(runId: number, account: string, flagMap: Map<string, FgListItem>) {
  return async (result: ScrapeResult): Promise<void> => {
    await writeResult(result);

    if (result.data) {
      const d: TimesheetData = result.data;
      const listItem = flagMap.get(result.timesheetId);

      // Update fingerprint with latest scraped data
      upsertFingerprint({
        ts_id:        d.metadata.timesheetId,
        account,
        status:       d.metadata.status,
        st_hours:     d.totals.regular,
        ot_hours:     d.totals.ot,
        dt_hours:     d.totals.dt,
        last_seen:    d.metadata.scrapedAt,
        last_scraped: d.metadata.scrapedAt,
      });
      markFingerprintScraped(d.metadata.timesheetId, account);

      insertRecord(runId, account, {
        ts_id:           d.metadata.timesheetId,
        employee:        d.metadata.employeeName,
        period_start:    d.metadata.periodStart ?? '',
        period_end:      d.metadata.periodEnd   ?? '',
        status:          d.metadata.status,
        client:          d.metadata.client      ?? '',
        total_hours:     d.totals.total,
        reg_hours:       d.totals.regular,
        ot_hours:        d.totals.ot,
        dt_hours:        d.totals.dt,
        confidence:      d.confidence,
        fallback:        d.fallbackUsed,
        flag:            listItem?.flag ?? 'new',
        scraped_at:      d.metadata.scrapedAt,
        json_path:       d.htmlPath ? path.join(path.dirname(d.htmlPath), '..', 'json', `${d.metadata.timesheetId}.json`) : undefined,
        screenshot_path: d.screenshotPath ?? undefined,
      });
    }
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function runAccount(accountId: string): Promise<void> {
  const log = logger.child({ account: accountId });

  const account = getAccount(accountId);
  if (!account) { log.error(`Account "${accountId}" not found in accounts.json`); return; }
  if (!account.enabled) { log.warn(`Account "${accountId}" is disabled`); return; }
  if (!acquireLock(accountId)) return;

  const runId = createRun(accountId, account.vmsType);
  broadcastStatus(accountId, 'running');
  log.info(`╔══ Starting run: ${account.label} (run #${runId}) ══╗`);

  process.env['FG_USERNAME'] = account.username;
  process.env['FG_PASSWORD'] = account.password;
  process.env['FG_BASE_URL'] = account.baseUrl;

  const context = await newContext();

  try {
    const { page: authPage } = await newPage(context);
    await loginFieldglass(authPage);

    // ── List + change detection ───────────────────────────────────────────────
    const { toScrape, unchanged, removed } = await scrapeFieldglassList(authPage, accountId);
    await authPage.close().catch(() => undefined);

    // Handle removed records — insert a 'removed' record in DB
    for (const tsId of removed) {
      log.warn(`[removed] ${tsId} no longer on VMS`);
      broadcastLog('warn', `${account.label}: ${tsId} removed from VMS`, accountId);
      // Insert a minimal removed record so it shows in dashboard
      insertRecord(runId, accountId, {
        ts_id: tsId, employee: '', period_start: '', period_end: '',
        status: 'removed_from_vms', client: '',
        total_hours: 0, reg_hours: 0, ot_hours: 0, dt_hours: 0,
        confidence: 0, fallback: 'none', flag: 'removed',
        scraped_at: new Date().toISOString(),
      });
    }

    const total = toScrape.length + unchanged.length + removed.length;

    if (toScrape.length === 0) {
      log.info(`Nothing changed — ${unchanged.length} unchanged, ${removed.length} removed`);
      broadcastLog('info', `${account.label}: All ${unchanged.length} unchanged — skipping detail scrape`, accountId);
      updateRun(runId, 'completed', { total, passed: 0, failed: 0 });
      broadcastStatus(accountId, 'idle');
      return;
    }

    log.info(`Scraping ${toScrape.length} changed/new (skipping ${unchanged.length} unchanged)`);
    broadcastLog('info', `${account.label}: ${toScrape.length} to scrape, ${unchanged.length} skipped`, accountId);

    // Build flag map for writer
    const flagMap = new Map(toScrape.map(i => [i.timesheetId, i]));

    const { passed, failed } = await runAll(
      context,
      toScrape,
      null,
      (page, item) => scrapeFieldglassDetail(page, item),
      makeResultWriter(runId, accountId, flagMap),
    );

    await writeSummary(passed, failed);
    updateRun(runId, 'completed', { total, passed: passed.length, failed: failed.length });

    broadcastLog('info',
      `${account.label}: ✓ ${passed.length} scraped, ${unchanged.length} unchanged, ${removed.length} removed`,
      accountId,
    );
    log.info(`╚══ Complete: ${account.label} ══╝`);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Run failed: ${msg}`);
    updateRun(runId, 'failed', { total: 0, passed: 0, failed: 0 }, msg);
    broadcastStatus(accountId, 'failed');
  } finally {
    releaseLock(accountId);
    await context.close().catch(() => undefined);
    broadcastStatus(accountId, 'idle');
  }
}
