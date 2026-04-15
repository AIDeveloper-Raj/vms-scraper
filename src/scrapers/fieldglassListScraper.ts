// ─────────────────────────────────────────────────────────────────────────────
// scrapers/fieldglassListScraper.ts — with change detection
// ─────────────────────────────────────────────────────────────────────────────

import type { Page }              from 'playwright';
import type { TimesheetListItem } from '../types';
import { config }                 from '../config';
import { logger }                 from '../utils/logger';
import {
  getFingerprints, upsertFingerprint, markFingerprintsRemoved,
  type ChangeFlag,
} from '../db/database';

interface FgColumn { name: string; value: string; html?: string; }
interface FgRow    { columns: FgColumn[]; }
interface FgGridData { rows: FgRow[]; }

// Extend TimesheetListItem to carry the change flag
export interface FgListItem extends TimesheetListItem {
  flag:       ChangeFlag;
  flagReason?: string;
}

export interface ListScrapeResult {
  toScrape: FgListItem[];     // new + changed — need detail page visit
  unchanged: FgListItem[];    // skip detail scraping
  removed:  string[];         // TS IDs no longer on VMS
}

// ── Date filter ───────────────────────────────────────────────────────────────

async function applyDateFilter(page: Page): Promise<void> {
  const { dateFrom, dateTo } = config.scraper;
  if (!dateFrom && !dateTo) return;
  const toFg = (iso: string) => { const [y,m,d] = iso.split('-'); return `${m}/${d}/${y}`; };
  if (dateFrom) await page.fill('input#filterStartDate', toFg(dateFrom)).catch(() => undefined);
  if (dateTo)   await page.fill('input#filterEndDate',   toFg(dateTo)).catch(() => undefined);
  try {
    await page.click('input.ttFilterButton');
    await page.waitForLoadState('networkidle', { timeout: 20_000 });
  } catch { /* continue */ }
}

// ── Extract grid rows ─────────────────────────────────────────────────────────

async function extractGridRows(page: Page): Promise<FgRow[]> {
  return page.evaluate((): FgRow[] => {
    const varName = Object.keys(window).find(k => k.startsWith('jsonObject_timeSheet_supplier_list_'));
    if (!varName) return [];
    const data = (window as unknown as Record<string, unknown>)[varName] as FgGridData | undefined;
    return data?.rows ?? [];
  });
}

function extractHref(html: string): string | null {
  const m = html.match(/href\s*=\s*\\?"([^"\\]+)\\?"/);
  if (!m) return null;
  return m[1]!.replace(/\\u003d/gi,'=').replace(/\\u0026/gi,'&').replace(/\\"/g,'"');
}

function rowToItem(row: FgRow): FgListItem | null {
  const cols: Record<string, FgColumn> = {};
  for (const col of row.columns) cols[col.name] = col;

  const tsRef = cols['time_sheet_ref'];
  if (!tsRef?.value) return null;

  let url = '';
  if (tsRef.html) {
    const href = extractHref(tsRef.html);
    if (href) url = href.startsWith('http') ? href : `${config.fieldglass.baseUrl}${href}`;
  }
  if (!url) return null;

  return {
    timesheetId:  tsRef.value,
    url,
    status:       cols['status']?.value      ?? '',
    employeeName: cols['worker_name']?.value  ?? '',
    period:       cols['end_date']?.value     ?? '',
    flag:         'new',  // will be set by change detection
    _stHours:     parseFloat(cols['st_hours']?.value ?? '0') || 0,
    _otHours:     parseFloat(cols['ot_hours']?.value ?? '0') || 0,
    _dtHours:     parseFloat(cols['dt_hours']?.value ?? '0') || 0,
  } as FgListItem & Record<string, unknown>;
}

// ── Change detection ──────────────────────────────────────────────────────────

function detectChanges(items: FgListItem[], account: string): ListScrapeResult {
  const fingerprints = getFingerprints(account);
  const currentIds   = new Set(items.map(i => i.timesheetId));
  const now          = new Date().toISOString();

  const toScrape:  FgListItem[] = [];
  const unchanged: FgListItem[] = [];

  for (const item of items) {
    const fp = fingerprints.get(item.timesheetId);
    const st = (item as unknown as Record<string, unknown>)['_stHours'] as number ?? 0;
    const ot = (item as unknown as Record<string, unknown>)['_otHours'] as number ?? 0;
    const dt = (item as unknown as Record<string, unknown>)['_dtHours'] as number ?? 0;

    if (!fp) {
      item.flag = 'new';
      toScrape.push(item);
    } else {
      const statusChanged = fp.status   !== item.status;
      const stChanged     = fp.st_hours !== st;
      const otChanged     = fp.ot_hours !== ot;
      const dtChanged     = fp.dt_hours !== dt;

      if (statusChanged || stChanged || otChanged || dtChanged) {
        item.flag = 'changed';
        item.flagReason = [
          statusChanged && `status: ${fp.status}→${item.status}`,
          stChanged     && `ST: ${fp.st_hours}→${st}`,
          otChanged     && `OT: ${fp.ot_hours}→${ot}`,
          dtChanged     && `DT: ${fp.dt_hours}→${dt}`,
        ].filter(Boolean).join(', ');
        toScrape.push(item);
      } else {
        item.flag = 'unchanged';
        unchanged.push(item);
        // Update last_seen without changing last_scraped
        upsertFingerprint({ ts_id: item.timesheetId, account, status: item.status ?? '',
          st_hours: st, ot_hours: ot, dt_hours: dt, last_seen: now, last_scraped: fp.last_scraped });
      }
    }
  }

  // Detect removed records
  const removed = markFingerprintsRemoved(account, currentIds);

  logger.info(`[FG Change] new=${toScrape.filter(i=>i.flag==='new').length} changed=${toScrape.filter(i=>i.flag==='changed').length} unchanged=${unchanged.length} removed=${removed.length}`);

  return { toScrape, unchanged, removed };
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function scrapeFieldglassList(page: Page, account: string): Promise<ListScrapeResult> {
  logger.info('[FG List] Navigating to timesheet list…');

  await page.goto(`${config.fieldglass.baseUrl}/time_sheet_list.do?cf=1`, { waitUntil: 'networkidle' });

  await page.waitForFunction(
    () => Object.keys(window).some(k => k.startsWith('jsonObject_timeSheet_supplier_list_')),
    { timeout: 20_000 },
  ).catch(() => logger.warn('[FG List] Grid JS variable timeout'));

  await applyDateFilter(page);

  const rows = await extractGridRows(page);
  logger.debug(`[FG List] Raw rows from grid: ${rows.length}`);

  let items = rows.map(rowToItem).filter(Boolean) as FgListItem[];

  // Apply MAX_RECORDS limit before change detection
  const limit = config.scraper.maxRecords;
  if (limit > 0 && items.length > limit) {
    logger.info(`[FG List] Limiting to ${limit} records`);
    items = items.slice(0, limit);
  }

  logger.info(`[FG List] ✓ ${items.length} timesheets found — running change detection`);
  return detectChanges(items, account);
}
