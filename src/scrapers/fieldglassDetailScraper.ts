// ─────────────────────────────────────────────────────────────────────────────
// scrapers/fieldglassDetailScraper.ts
//
// Fieldglass detail page structure:
//   METADATA  → DOM [data-help-id] labels (Status, Period, TS ID, Buyer)
//               Worker name from initBadge() JS JSON "title" field
//   ENTRIES   → Horizontal weekly table (table.timeSheetBox)
//               Columns = days, rows = rate codes (ST/Hr, OT/Hr etc)
//               Hours format varies: ABO="8h 0m", AMD="8.00"
//   TOTALS    → tr.timeSheetTotal td:last-child
// ─────────────────────────────────────────────────────────────────────────────

import * as path from 'path';
import * as fs from 'fs/promises';
import type { Page } from 'playwright';
import type {
  TimesheetData,
  TimesheetEntry,
  TimesheetListItem,
  EarningsCode,
} from '../types';
import { config } from '../config';
import { taskLogger } from '../utils/logger';
import { scoreConfidence } from '../utils/confidence';
import { buildNormalizer } from '../utils/earningsNormalizer';
import { parseFgHours, parseFgColumnDate, extractYearFromPeriod } from '../utils/fgHoursParser';
import { runOcrFallback } from '../fallback/ocrParser';
import { runLlmFallback } from '../fallback/llmParser';
import { randomDelay } from '../utils/humanDelay';

const normalize = buildNormalizer();

// ── Metadata extraction ───────────────────────────────────────────────────────

async function extractMetadata(page: Page): Promise<{
  timesheetId: string;
  status: string;
  period: string;
  workerName: string;
  buyer: string;
}> {
  const getText = async (selectors: string[]): Promise<string> => {
    for (const sel of selectors) {
      try {
        const el = page.locator(sel).first();
        if ((await el.count()) > 0) {
          const t = await el.textContent({ timeout: 3_000 });
          if (t?.trim()) return t.trim();
        }
      } catch { /* try next */ }
    }
    return '';
  };

  const [timesheetId, status, period, buyer] = await Promise.all([
    getText([
      "[data-help-id='LABEL_TIMESHEET_REF_70'] .values",
      "[data-help-id*='LABEL_TIMESHEET_REF'] .values",
      '#detailTabButtonHolder .values a',
      '#detailTabButtonHolder .values',
    ]),
    getText([
      "[data-help-id='LABEL_STATUS_70'] .values",
      "[data-help-id*='LABEL_STATUS'] .values",
      '.fd-object-status__text',
    ]),
    getText([
      "[data-help-id='LABEL_PERIOD_70'] .values",
      "[data-help-id*='LABEL_PERIOD'] .values",
    ]),
    getText([
      "[data-help-id='LABEL_BUYER_70'] .values",
      "[data-help-id*='LABEL_BUYER'] .values",
    ]),
  ]);

  // Worker name lives in the initBadge() JS call as the "title" field
  const workerName = await page.evaluate((): string => {
    const scripts = Array.from(document.querySelectorAll('script'));
    for (const s of scripts) {
      const m = s.textContent?.match(/initBadge\s*\(\s*\{[^}]*"title"\s*:\s*"([^"]+)"/);
      if (m) return m[1]!;
    }
    return '';
  }).catch(() => '');

  return { timesheetId, status, period, workerName, buyer };
}

// ── Time entries extraction ───────────────────────────────────────────────────
// Strategy: find the "Time Sheet Rate Group" panel (most reliable for rate codes),
// extract column dates from its header row, then read each rate code row.

interface RawEntry {
  date: string;
  hours: number;
  rawCode: string;
}

async function extractEntries(page: Page, period: string): Promise<TimesheetEntry[]> {
  const periodYear = extractYearFromPeriod(period);

  const rawEntries: RawEntry[] = await page.evaluate(
    ({ year }: { year: string }): RawEntry[] => {
      // Find the panel whose title contains "Rate Group" or "Time Worked"
      // We prefer "Time Sheet Rate Group" as it explicitly shows earnings codes.
      // Fall back to "Time Worked" panel if Rate Group is absent.

      function parseFgHoursInBrowser(raw: string): number {
        const s = (raw ?? '').trim();
        if (!s || s === '-') return 0;
        const hm = s.match(/^(\d+)h\s*(\d+)m$/i);
        if (hm) return Math.round((parseInt(hm[1]!) + parseInt(hm[2]!) / 60) * 100) / 100;
        const n = parseFloat(s.replace(/[^0-9.-]/g, ''));
        return isNaN(n) ? 0 : Math.round(n * 100) / 100;
      }

      function parseDateHeader(text: string, yr: string): string {
        const s = text.replace(/\s*(Mon|Tue|Wed|Thu|Fri|Sat|Sun).*/i, '').trim();
        const parts = s.split(/[\/\-]/);
        if (parts.length === 2) {
          return `${yr}-${parts[0]!.padStart(2, '0')}-${parts[1]!.padStart(2, '0')}`;
        }
        return s;
      }

      const panels = Array.from(
        document.querySelectorAll<HTMLElement>('div.fd-panel--fixed'),
      );

      // Priority: Rate Group panel > Time Worked panel
      let targetPanel = panels.find((p) => {
        const title = p.querySelector('.fd-panel__title')?.textContent ?? '';
        return /rate group/i.test(title);
      });
      if (!targetPanel) {
        targetPanel = panels.find((p) => {
          const title = p.querySelector('.fd-panel__title')?.textContent ?? '';
          return /time worked/i.test(title);
        });
      }
      if (!targetPanel) return [];

      const table = targetPanel.querySelector<HTMLTableElement>('table.timeSheetBox');
      if (!table) return [];

      // Get column dates from header row (skip first "Day" column, skip last "Total" column)
      const headerRow = table.querySelector<HTMLTableRowElement>('tr.subheaders');
      if (!headerRow) return [];

      const dateCells = Array.from(
        headerRow.querySelectorAll<HTMLTableCellElement>('th.dateAndDay'),
      );
      // Last cell is "Total Worked" — exclude it
      const dayColumns = dateCells.slice(0, dateCells.length - 1);

      const dates = dayColumns.map((th) => {
        const raw = (th.firstChild?.textContent ?? th.textContent ?? '').trim();
        return parseDateHeader(raw, year);
      });

      const entries: RawEntry[] = [];

      // Each data row: first cell = rate code label, subsequent cells = hours per day
      const dataRows = Array.from(
        table.querySelectorAll<HTMLTableRowElement>('tbody tr'),
      ).filter((tr) => {
        // skip header rows and total row
        const cls = tr.className;
        return !cls.includes('subheaders') && !cls.includes('timeSheetTotal') &&
          !cls.includes('secondaryHeader') && !cls.includes('timeSheetTableSecondaryHeader');
      });

      for (const row of dataRows) {
        const codeCell = row.querySelector<HTMLElement>('th[scope="row"]');
        if (!codeCell) continue;

        const rawCode = codeCell.textContent?.trim() ?? '';
        if (!rawCode) continue;

        // Skip accounting / non-hours rows (e.g. "Subtotal", "Total", billing rows)
        if (/subtotal|pay to|bill to|amount|rate\s*$/i.test(rawCode)) continue;

        const tdCells = Array.from(row.querySelectorAll<HTMLTableCellElement>('td'));
        // Exclude cells from non-working day columns for the entry list
        for (let i = 0; i < dates.length && i < tdCells.length; i++) {
          const cell = tdCells[i]!;
          const isNonWorking = cell.classList.contains('nonWorkingDayBGColor');
          const hoursText = cell.textContent?.trim() ?? '';
          const hours = parseFgHoursInBrowser(hoursText);

          if (hours > 0) {
            entries.push({ date: dates[i]!, hours, rawCode });
          } else if (!isNonWorking && hoursText && hoursText !== '-' && hoursText !== '0h 0m' && hoursText !== '0.00') {
            // Record zero explicitly for working days with explicit zero
            entries.push({ date: dates[i]!, hours: 0, rawCode });
          }
        }
      }

      return entries;
    },
    { year: periodYear },
  ).catch(() => []);

  // Aggregate hours by date+code — multiple projects on same day/code must be summed
  const aggregated = new Map<string, { hours: number; rawCode: string }>();

  for (const raw of rawEntries) {
    if (raw.hours === 0) continue;
    const key = `${raw.date}|${raw.rawCode}`;
    const existing = aggregated.get(key);
    if (existing) {
      existing.hours = Math.round((existing.hours + raw.hours) * 100) / 100;
    } else {
      aggregated.set(key, { hours: raw.hours, rawCode: raw.rawCode });
    }
  }

  const entries: TimesheetEntry[] = Array.from(aggregated.entries()).map(([key, val]) => ({
    date: key.split('|')[0]!,
    hours: val.hours,
    rawType: val.rawCode,
    type: normalize(val.rawCode) as EarningsCode,
  }));

  return entries;
}

// ── Totals extraction ─────────────────────────────────────────────────────────

async function extractTotals(page: Page): Promise<number> {
  // tr.timeSheetTotal last td — from the Time Worked panel (most reliable total)
  const totalText = await page.evaluate((): string => {
    const totalRows = document.querySelectorAll('tr.timeSheetTotal');
    for (const row of Array.from(totalRows)) {
      const cells = row.querySelectorAll('td');
      const last = cells[cells.length - 1];
      if (last?.textContent?.trim()) return last.textContent.trim();
    }
    return '';
  }).catch(() => '');

  return parseFgHours(totalText);
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function scrapeFieldglassDetail(
  page: Page,
  item: TimesheetListItem,
): Promise<TimesheetData> {
  const log = taskLogger(item.timesheetId);
  const scrapedAt = new Date().toISOString();

  log.info(`→ ${item.url}`);
  await randomDelay(1500, 3500); // human-like pause before each page load
  await page.goto(item.url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1_000); // let Angular/React components mount

  // ── Level 1: DOM + JS extraction ──────────────────────────────────────────
  const [meta, entries, totalHours] = await Promise.all([
    extractMetadata(page),
    extractEntries(page, item.period ?? ''),
    extractTotals(page),
  ]);

  const computedTotal = entries.reduce((s, e) => s + e.hours, 0);
  const regularHours = entries.filter((e) => e.type === 'REG').reduce((s, e) => s + e.hours, 0);
  const otHours = entries.filter((e) => e.type === 'OT').reduce((s, e) => s + e.hours, 0);
  const dtHours = entries.filter((e) => e.type === 'DT').reduce((s, e) => s + e.hours, 0);

  // Parse period into start/end
  const periodParts = (meta.period || item.period || '').split(/\s+to\s+/i);

  let data: TimesheetData = {
    metadata: {
      timesheetId: meta.timesheetId || item.timesheetId,
      employeeName: meta.workerName || item.employeeName || '',
      status: meta.status || item.status || '',
      period: meta.period || item.period || '',
      periodStart: periodParts[0]?.trim() ?? '',
      periodEnd: periodParts[1]?.trim() ?? '',
      client: meta.buyer,
      url: item.url,
      scrapedAt,
    },
    entries,
    totals: {
      regular: regularHours,
      ot: otHours,
      dt: dtHours,
      holiday: entries.filter((e) => e.type === 'HOL').reduce((s, e) => s + e.hours, 0),
      sick: entries.filter((e) => e.type === 'SICK').reduce((s, e) => s + e.hours, 0),
      vacation: entries.filter((e) => e.type === 'VAC').reduce((s, e) => s + e.hours, 0),
      total: totalHours || computedTotal,
    },
    confidence: 0,
    fallbackUsed: 'none',
  };

  const report1 = scoreConfidence(data);
  data.confidence = report1.score;
  log.info(`Selector confidence: ${(report1.score * 100).toFixed(1)}%`);

  // ── Always save screenshot + HTML ─────────────────────────────────────────
  const safeId = item.timesheetId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const screenshotPath = path.join(config.output.screenshots, `${safeId}.png`);
  const htmlPath = path.join(config.output.html, `${safeId}.html`);

  await page.screenshot({ path: screenshotPath, fullPage: true });
  await fs.writeFile(htmlPath, await page.content(), 'utf-8');
  data.screenshotPath = screenshotPath;
  data.htmlPath = htmlPath;

  if (data.confidence >= config.scraper.confidenceThreshold) {
    log.info(`✓ Confidence OK — no fallback needed`);
    return data;
  }

  // ── Level 2: OCR fallback ─────────────────────────────────────────────────
  log.warn(`Low confidence (${(data.confidence * 100).toFixed(1)}%) — trying OCR…`);
  try {
    const ocrData = await runOcrFallback(screenshotPath, data);
    const ocrReport = scoreConfidence(ocrData);
    ocrData.confidence = ocrReport.score;
    if (ocrReport.score > data.confidence) {
      data = { ...ocrData, fallbackUsed: 'ocr', screenshotPath, htmlPath };
      log.info(`OCR improved confidence to ${(ocrReport.score * 100).toFixed(1)}%`);
    }
  } catch (err) {
    log.warn(`OCR failed: ${(err as Error).message}`);
  }

  if (data.confidence >= config.scraper.confidenceThreshold) return data;

  // ── Level 3: LLM fallback ─────────────────────────────────────────────────
  if (!config.openai.apiKey) {
    log.warn('LLM fallback skipped — OPENAI_API_KEY not set');
    return data;
  }

  log.warn(`Still low confidence — trying LLM…`);
  try {
    const html = await fs.readFile(htmlPath, 'utf-8');
    const llmData = await runLlmFallback(screenshotPath, html, data);
    const llmReport = scoreConfidence(llmData);
    llmData.confidence = llmReport.score;
    if (llmReport.score > data.confidence) {
      data = { ...llmData, fallbackUsed: 'llm', screenshotPath, htmlPath };
      log.info(`LLM improved confidence to ${(llmReport.score * 100).toFixed(1)}%`);
    }
  } catch (err) {
    log.error(`LLM failed: ${(err as Error).message}`);
  }

  log.info(`Final: ${(data.confidence * 100).toFixed(1)}% [${data.fallbackUsed}]`);
  return data;
}
