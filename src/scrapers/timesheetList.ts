// ─────────────────────────────────────────────────────────────────────────────
// scrapers/timesheetList.ts — Extract all timesheet links from list/grid view
// ─────────────────────────────────────────────────────────────────────────────

import type { Page } from 'playwright';
import type { VMSStructure, TimesheetListItem } from '../types';
import { config } from '../config';
import { logger } from '../utils/logger';

async function applyDateFilter(page: Page, structure: VMSStructure): Promise<void> {
  const { dateFrom, dateTo } = config.scraper;
  const lp = structure.listPage;

  if (!dateFrom && !dateTo) return;

  logger.info(`Applying date filter: ${dateFrom || 'start'} → ${dateTo || 'now'}`);

  if (dateFrom && lp.dateFilterFrom) {
    for (const sel of lp.dateFilterFrom) {
      try {
        const el = page.locator(sel).first();
        if ((await el.count()) === 0) continue;
        await el.fill(dateFrom);
        logger.debug(`Date-from set via: ${sel}`);
        break;
      } catch { /* try next */ }
    }
  }

  if (dateTo && lp.dateFilterTo) {
    for (const sel of lp.dateFilterTo) {
      try {
        const el = page.locator(sel).first();
        if ((await el.count()) === 0) continue;
        await el.fill(dateTo);
        logger.debug(`Date-to set via: ${sel}`);
        break;
      } catch { /* try next */ }
    }
  }

  if (lp.applyFilterButton) {
    for (const sel of lp.applyFilterButton) {
      try {
        const el = page.locator(sel).first();
        if ((await el.count()) === 0) continue;
        await el.click();
        await page.waitForLoadState('networkidle', { timeout: 15_000 });
        logger.info('Date filter applied');
        break;
      } catch { /* try next */ }
    }
  }
}

async function extractRowsFromCurrentPage(
  page: Page,
  structure: VMSStructure,
): Promise<TimesheetListItem[]> {
  const lp = structure.listPage;
  const items: TimesheetListItem[] = [];

  // Find the table container
  let tableFound = false;
  for (const containerSel of lp.tableContainer) {
    try {
      if ((await page.locator(containerSel).count()) > 0) {
        tableFound = true;
        logger.debug(`Timesheet list container matched: ${containerSel}`);
        break;
      }
    } catch { /* try next */ }
  }

  if (!tableFound) {
    logger.warn('Could not locate timesheet list table');
    return items;
  }

  const rows = page.locator(`${lp.tableContainer[0]} ${lp.rowSelector}`);
  const rowCount = await rows.count();
  logger.debug(`Found ${rowCount} rows on current page`);

  for (let i = 0; i < rowCount; i++) {
    const row = rows.nth(i);
    const cols = lp.columns;

    try {
      // Extract href for detail link
      let href: string | null = null;
      for (const sel of cols.link.selectors) {
        try {
          const link = row.locator(sel).first();
          if ((await link.count()) === 0) continue;
          href = await link.getAttribute('href');
          if (href) break;
        } catch { /* continue */ }
      }
      // Fallback: first <a> in row
      if (!href) {
        href = await row.locator('a').first().getAttribute('href').catch(() => null);
      }

      if (!href) {
        logger.debug(`Row ${i}: no link found, skipping`);
        continue;
      }

      // Resolve relative URLs
      const url = href.startsWith('http') ? href : new URL(href, config.beeline.url).toString();

      // Extract text fields
      const getText = async (fieldSelectors: string[], cellIndex: number): Promise<string> => {
        for (const sel of fieldSelectors) {
          try {
            const el = row.locator(sel).first();
            if ((await el.count()) === 0) continue;
            const text = await el.textContent({ timeout: 1_500 });
            if (text?.trim()) return text.trim();
          } catch { /* continue */ }
        }
        // Fallback to nth cell
        try {
          const cell = row.locator('td').nth(cellIndex);
          return (await cell.textContent({ timeout: 1_500 }))?.trim() ?? '';
        } catch {
          return '';
        }
      };

      const [period, status, employeeName, timesheetIdText] = await Promise.all([
        getText(cols.period.selectors, cols.period.cellIndex ?? 1),
        getText(cols.status.selectors, cols.status.cellIndex ?? 2),
        getText(cols.employeeName.selectors, cols.employeeName.cellIndex ?? 3),
        getText(cols.timesheetId.selectors, cols.timesheetId.cellIndex ?? 0),
      ]);

      // Derive a timesheet ID from URL if not found in the table
      const timesheetId = timesheetIdText || url.split('/').filter(Boolean).pop() || `ts-${i}`;

      items.push({ timesheetId, url, period, status, employeeName });
    } catch (err) {
      logger.warn(`Failed to extract row ${i}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return items;
}

async function hasNextPage(page: Page, structure: VMSStructure): Promise<boolean> {
  const btns = structure.listPage.nextPageButton;
  if (!btns) return false;

  for (const sel of btns) {
    try {
      const btn = page.locator(sel).first();
      if ((await btn.count()) === 0) continue;
      const disabled = await btn.getAttribute('disabled');
      const ariaDisabled = await btn.getAttribute('aria-disabled');
      if (disabled === null && ariaDisabled !== 'true') return true;
    } catch { /* continue */ }
  }
  return false;
}

async function clickNextPage(page: Page, structure: VMSStructure): Promise<void> {
  const btns = structure.listPage.nextPageButton!;
  for (const sel of btns) {
    try {
      const btn = page.locator(sel).first();
      if ((await btn.count()) === 0) continue;
      await btn.click();
      await page.waitForLoadState('networkidle', { timeout: 15_000 });
      return;
    } catch { /* continue */ }
  }
}

export async function scrapeTimesheetList(
  page: Page,
  structure: VMSStructure,
): Promise<TimesheetListItem[]> {
  logger.info('Navigating to timesheet list…');

  // Navigate — try URL path first, then click through menu
  if (structure.navigation.timesheetListUrl) {
    const fullUrl = new URL(structure.navigation.timesheetListUrl, config.beeline.url).toString();
    await page.goto(fullUrl, { waitUntil: 'networkidle' });
  } else {
    for (const sel of structure.navigation.timesheetMenuPath) {
      try {
        const el = page.locator(sel).first();
        if ((await el.count()) === 0) continue;
        await el.click();
        await page.waitForLoadState('networkidle', { timeout: 20_000 });
        logger.debug(`Navigated via menu selector: ${sel}`);
        break;
      } catch { /* try next */ }
    }
  }

  await applyDateFilter(page, structure);

  const allItems: TimesheetListItem[] = [];
  let pageNum = 1;

  while (true) {
    logger.info(`Extracting timesheet list — page ${pageNum}`);
    const items = await extractRowsFromCurrentPage(page, structure);
    allItems.push(...items);
    logger.info(`Page ${pageNum}: found ${items.length} timesheets (total so far: ${allItems.length})`);

    if (!(await hasNextPage(page, structure))) break;

    await clickNextPage(page, structure);
    pageNum++;
  }

  logger.info(`✓ Total timesheets discovered: ${allItems.length}`);
  return allItems;
}
