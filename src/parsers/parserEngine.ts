// ─────────────────────────────────────────────────────────────────────────────
// parsers/parserEngine.ts — Selector-waterfall extraction engine
//
// DESIGN: Never throw on missing fields. Collect what's there, score later.
// ─────────────────────────────────────────────────────────────────────────────

import type { Page } from 'playwright';
import type {
  VMSStructure,
  TimesheetData,
  TimesheetEntry,
  TimesheetTotals,
  TimesheetMetadata,
  FieldDefinition,
  RowFieldDefinition,
} from '../types';
import { buildNormalizer } from '../utils/earningsNormalizer';
import { logger } from '../utils/logger';
import { parseDate } from './dateParser';

// ── Selector waterfall ────────────────────────────────────────────────────────

async function trySelectors(
  page: Page,
  selectors: string[],
  transform: FieldDefinition['transform'] = 'text',
): Promise<string | null> {
  for (const selector of selectors) {
    try {
      // Attempt text= style locators AND CSS selectors
      const locator = page.locator(selector).first();
      const count = await locator.count();
      if (count === 0) continue;

      let raw = '';
      if (transform === 'text' || transform === 'trim' || transform === 'date' || transform === 'number') {
        raw = await locator.textContent({ timeout: 3_000 }) ?? '';
      }

      const cleaned = raw.trim();
      if (cleaned) {
        return cleaned;
      }
    } catch {
      // selector not found — try next
    }
  }
  return null;
}

async function trySelectorsForAttr(page: Page, selectors: string[], attr: string): Promise<string | null> {
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      if ((await locator.count()) === 0) continue;
      const val = await locator.getAttribute(attr, { timeout: 3_000 });
      if (val?.trim()) return val.trim();
    } catch {
      // continue
    }
  }
  return null;
}

function applyTransform(raw: string, transform?: FieldDefinition['transform']): string | number {
  const cleaned = raw.replace(/[\u00a0\u200b]/g, ' ').trim(); // strip NBSP/zero-width spaces
  switch (transform) {
    case 'number': {
      const n = parseFloat(cleaned.replace(/[^0-9.-]/g, ''));
      return isNaN(n) ? 0 : n;
    }
    case 'date':
      return parseDate(cleaned);
    case 'trim':
    case 'text':
    default:
      return cleaned;
  }
}

// ── Row extraction ────────────────────────────────────────────────────────────

async function extractEntries(
  page: Page,
  structure: VMSStructure,
  normalize: ReturnType<typeof buildNormalizer>,
): Promise<TimesheetEntry[]> {
  const rowDef = structure.detailPage.entriesTable;
  const entries: TimesheetEntry[] = [];

  // Find the container
  let containerHandle = null;
  for (const sel of rowDef.containerSelector) {
    try {
      const count = await page.locator(sel).count();
      if (count > 0) {
        containerHandle = page.locator(sel).first();
        logger.debug(`entries container matched: ${sel}`);
        break;
      }
    } catch { /* try next */ }
  }

  if (!containerHandle) {
    logger.warn('Could not find entries table container with any selector');
    return entries;
  }

  // Get all rows
  const rows = containerHandle.locator(rowDef.rowSelector);
  const rowCount = await rows.count();
  logger.debug(`Found ${rowCount} entry rows`);

  for (let i = 0; i < rowCount; i++) {
    const row = rows.nth(i);
    const entry: Partial<TimesheetEntry> = {};

    for (const [fieldName, fieldDef] of Object.entries(rowDef.fields) as [string, RowFieldDefinition][]) {
      let value: string | null = null;

      // Try CSS selectors within the row
      for (const sel of fieldDef.selectors) {
        try {
          const cell = row.locator(sel).first();
          if ((await cell.count()) > 0) {
            value = (await cell.textContent({ timeout: 2_000 }))?.trim() ?? null;
            if (value) break;
          }
        } catch { /* continue */ }
      }

      // Fallback: nth cell by index
      if (!value && fieldDef.cellIndex !== undefined) {
        try {
          const cell = row.locator('td').nth(fieldDef.cellIndex);
          if ((await cell.count()) > 0) {
            value = (await cell.textContent({ timeout: 2_000 }))?.trim() ?? null;
          }
        } catch { /* continue */ }
      }

      if (value) {
        const transformed = applyTransform(value, fieldDef.transform);
        (entry as Record<string, unknown>)[fieldName] = transformed;
      }
    }

    // Skip empty rows
    if (!entry.hours && entry.hours !== 0) continue;
    if (!entry.date) continue;

    const rawType = String(entry['type'] ?? '');
    entries.push({
      date: String(entry.date ?? ''),
      hours: Number(entry.hours ?? 0),
      rawType,
      type: normalize(rawType),
      notes: entry.notes ? String(entry.notes) : undefined,
    });
  }

  return entries;
}

// ── Totals extraction ─────────────────────────────────────────────────────────

async function extractTotals(page: Page, structure: VMSStructure): Promise<TimesheetTotals> {
  const t = structure.detailPage.totals;

  const get = async (def: FieldDefinition): Promise<number> => {
    const raw = await trySelectors(page, def.selectors, 'number');
    if (!raw) return 0;
    const n = parseFloat(raw.replace(/[^0-9.-]/g, ''));
    return isNaN(n) ? 0 : n;
  };

  const regular = await get(t.regular);
  const ot = await get(t.ot);
  const dt = t.dt ? await get(t.dt) : 0;
  const total = await get(t.total);

  return {
    regular,
    ot,
    dt,
    holiday: 0,
    sick: 0,
    vacation: 0,
    total: total || regular + ot + dt,
  };
}

// ── Main extraction ───────────────────────────────────────────────────────────

export async function parseTimesheetDetail(
  page: Page,
  structure: VMSStructure,
  partialMeta: Pick<TimesheetMetadata, 'timesheetId' | 'url' | 'scrapedAt'>,
): Promise<TimesheetData> {
  const normalize = buildNormalizer(structure);
  const dp = structure.detailPage;

  logger.debug('Extracting metadata fields…');

  const [employeeName, period, status, client, project] = await Promise.all([
    trySelectors(page, dp.employeeName.selectors, 'trim'),
    trySelectors(page, dp.period.selectors, 'trim'),
    trySelectors(page, dp.status.selectors, 'trim'),
    dp.client ? trySelectors(page, dp.client.selectors, 'trim') : Promise.resolve(null),
    dp.project ? trySelectors(page, dp.project.selectors, 'trim') : Promise.resolve(null),
  ]);

  // Attempt to parse period into start/end dates
  const { periodStart, periodEnd } = parsePeriod(period ?? '');

  const entries = await extractEntries(page, structure, normalize);
  const totals = await extractTotals(page, structure);

  // If totals.total is 0, compute from entries
  if (totals.total === 0 && entries.length > 0) {
    totals.total = entries.reduce((s, e) => s + e.hours, 0);
  }

  const data: TimesheetData = {
    metadata: {
      ...partialMeta,
      employeeName: employeeName ?? '',
      period: period ?? '',
      periodStart,
      periodEnd,
      status: status ?? '',
      client: client ?? undefined,
      project: project ?? undefined,
    },
    entries,
    totals,
    confidence: 0,          // scored externally
    fallbackUsed: 'none',
    screenshotPath: undefined,
    htmlPath: undefined,
  };

  return data;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parsePeriod(period: string): { periodStart: string; periodEnd: string } {
  // Common formats: "01/01/2024 - 01/07/2024", "Jan 1 – Jan 7, 2024"
  const sep = /[-–—to]+/;
  const parts = period.split(sep).map((p) => p.trim()).filter(Boolean);

  if (parts.length >= 2) {
    return {
      periodStart: parseDate(parts[0]!),
      periodEnd: parseDate(parts[parts.length - 1]!),
    };
  }

  return { periodStart: '', periodEnd: '' };
}
