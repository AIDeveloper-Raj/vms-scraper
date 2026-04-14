// ─────────────────────────────────────────────────────────────────────────────
// fallback/ocrParser.ts — Extract timesheet data from screenshot via Tesseract
// ─────────────────────────────────────────────────────────────────────────────

import Tesseract from 'tesseract.js';
import type { TimesheetData, TimesheetEntry, EarningsCode } from '../types';
import { logger } from '../utils/logger';
import { parseDate } from '../parsers/dateParser';
import { buildNormalizer } from '../utils/earningsNormalizer';

const normalize = buildNormalizer();

// ── OCR runner ────────────────────────────────────────────────────────────────

async function performOcr(imagePath: string): Promise<string> {
  logger.debug(`Running Tesseract OCR on: ${imagePath}`);
  const result = await Tesseract.recognize(imagePath, 'eng', {
    logger: (m) => {
      if (m.status === 'recognizing text') {
        logger.debug(`OCR progress: ${Math.round((m.progress ?? 0) * 100)}%`);
      }
    },
  });

  const text = result.data.text;
  logger.debug(`OCR extracted ${text.length} characters`);
  return text;
}

// ── Line-level heuristic parsing ──────────────────────────────────────────────
// OCR gives us raw text — we use heuristics to find structure.

const DATE_PATTERN = /\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\w{3,9}\s+\d{1,2}[,\s]+\d{4})\b/;
const HOURS_PATTERN = /\b(\d{1,2}(?:\.\d{1,2})?)\s*(?:hrs?|hours?)?\b/i;
const EARNINGS_PATTERN = /\b(REG|OT|DT|HOL|SICK|VAC|Regular|Overtime|Double|Holiday|Vacation|Sick)\b/i;
const PERIOD_PATTERN = /(?:Period|Week|Pay Period)[:\s]+(.+?)(?:\n|$)/i;
const NAME_PATTERN = /(?:Worker|Employee|Name)[:\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/;
const STATUS_PATTERN = /(?:Status)[:\s]+(\w+(?:\s+\w+)?)/i;
const TOTAL_PATTERN = /(?:Total|Grand Total)[:\s:]+(\d+(?:\.\d+)?)/i;

interface ParsedRow {
  date: string;
  hours: number;
  rawType: string;
  type: EarningsCode;
}

function parseEntries(text: string): ParsedRow[] {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const entries: ParsedRow[] = [];

  for (const line of lines) {
    const dateMatch = line.match(DATE_PATTERN);
    const hoursMatch = line.match(HOURS_PATTERN);
    const typeMatch = line.match(EARNINGS_PATTERN);

    if (!dateMatch || !hoursMatch) continue;

    const hours = parseFloat(hoursMatch[1]!);
    if (isNaN(hours) || hours < 0 || hours > 24) continue;

    const rawType = typeMatch?.[1] ?? 'REG';
    entries.push({
      date: parseDate(dateMatch[1]!),
      hours,
      rawType,
      type: normalize(rawType),
    });
  }

  return entries;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function runOcrFallback(
  screenshotPath: string,
  existingData: TimesheetData,
): Promise<TimesheetData> {
  const text = await performOcr(screenshotPath);

  // Attempt to extract missing metadata from OCR text
  const periodMatch = text.match(PERIOD_PATTERN);
  const nameMatch = text.match(NAME_PATTERN);
  const statusMatch = text.match(STATUS_PATTERN);
  const totalMatch = text.match(TOTAL_PATTERN);

  // Merge OCR findings with existing data (OCR fills gaps, doesn't overwrite good data)
  const metadata = {
    ...existingData.metadata,
    employeeName: existingData.metadata.employeeName || nameMatch?.[1]?.trim() || '',
    period: existingData.metadata.period || periodMatch?.[1]?.trim() || '',
    status: existingData.metadata.status || statusMatch?.[1]?.trim() || '',
  };

  // Parse entries from OCR text
  const ocrEntries = parseEntries(text);

  // Use OCR entries only if we got more than what selectors found
  const entries: TimesheetEntry[] = ocrEntries.length > existingData.entries.length
    ? ocrEntries
    : existingData.entries;

  // Total
  const ocrTotal = totalMatch ? parseFloat(totalMatch[1]!) : 0;
  const computedTotal = entries.reduce((s, e) => s + e.hours, 0);
  const total = ocrTotal || computedTotal;

  return {
    ...existingData,
    metadata,
    entries,
    totals: {
      ...existingData.totals,
      total: total || existingData.totals.total,
    },
  };
}
