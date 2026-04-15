// ─────────────────────────────────────────────────────────────────────────────
// fallback/ocrParser.ts — OCR fallback using Google Cloud Vision API
//
// Uses DOCUMENT_TEXT_DETECTION which is optimised for dense text like tables.
// Falls back to regex heuristics to find timesheet fields in the extracted text.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'fs/promises';
import * as https from 'https';
import type { TimesheetData, TimesheetEntry, EarningsCode } from '../types';
import { config } from '../config';
import { logger } from '../utils/logger';
import { parseDate } from '../parsers/dateParser';
import { buildNormalizer } from '../utils/earningsNormalizer';

const normalize = buildNormalizer();

// ── GCP Vision REST API call ──────────────────────────────────────────────────
// We use the REST API directly — no extra SDK dependency needed.
// Auth: API key (simplest for POC; swap for service account JWT in production).

interface VisionAnnotation {
  description: string;
  boundingPoly?: unknown;
}

interface VisionResponse {
  responses: Array<{
    fullTextAnnotation?: { text: string };
    textAnnotations?: VisionAnnotation[];
    error?: { message: string; code: number };
  }>;
}

async function callVisionApi(base64Image: string): Promise<string> {
  const apiKey = config.gcp.visionApiKey;
  if (!apiKey) throw new Error('GCP_VISION_API_KEY is not set — OCR fallback unavailable');

  const body = JSON.stringify({
    requests: [{
      image:    { content: base64Image },
      features: [{ type: 'DOCUMENT_TEXT_DETECTION', maxResults: 1 }],
    }],
  });

  return new Promise((resolve, reject) => {
    const url = `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`;
    const req = https.request(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed: VisionResponse = JSON.parse(data);
          const response = parsed.responses[0];

          if (response?.error) {
            reject(new Error(`GCP Vision API error ${response.error.code}: ${response.error.message}`));
            return;
          }

          // fullTextAnnotation preserves layout better than textAnnotations[0]
          const text =
            response?.fullTextAnnotation?.text ??
            response?.textAnnotations?.[0]?.description ??
            '';

          resolve(text);
        } catch (err) {
          reject(new Error(`Failed to parse Vision API response: ${(err as Error).message}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Heuristic text parsing ────────────────────────────────────────────────────

const DATE_RE     = /\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\w{3,9}\s+\d{1,2}[,\s]+\d{4})\b/;
const HOURS_RE    = /\b(\d{1,2}(?:\.\d{1,2})?)\s*(?:hrs?|hours?)?\b/i;
const EARNINGS_RE = /\b(REG|OT|DT|HOL|SICK|VAC|Regular|Overtime|Double|Holiday|Vacation|Sick)\b/i;
const PERIOD_RE   = /(?:Period|Week|Pay Period)[:\s]+(.+?)(?:\n|$)/i;
const NAME_RE     = /(?:Worker|Employee|Name)[:\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/;
const STATUS_RE   = /(?:Status)[:\s]+(\w+(?:\s+\w+)?)/i;
const TOTAL_RE    = /(?:Grand\s+)?Total[:\s]+(\d+(?:\.\d+)?)/i;

interface ParsedRow { date: string; hours: number; rawType: string; type: EarningsCode }

function parseEntries(text: string): ParsedRow[] {
  const entries: ParsedRow[] = [];

  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const dateMatch  = line.match(DATE_RE);
    const hoursMatch = line.match(HOURS_RE);
    if (!dateMatch || !hoursMatch) continue;

    const hours = parseFloat(hoursMatch[1]!);
    if (isNaN(hours) || hours < 0 || hours > 24) continue;

    const rawType = line.match(EARNINGS_RE)?.[1] ?? 'REG';
    entries.push({ date: parseDate(dateMatch[1]!), hours, rawType, type: normalize(rawType) as EarningsCode });
  }

  return entries;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function runOcrFallback(
  screenshotPath: string,
  existingData: TimesheetData,
): Promise<TimesheetData> {
  logger.info('[OCR] Calling Google Cloud Vision API…');

  const base64Image = (await fs.readFile(screenshotPath)).toString('base64');
  const text = await callVisionApi(base64Image);

  logger.debug(`[OCR] Extracted ${text.length} characters from screenshot`);

  // Extract metadata from OCR text (only fills gaps — never overwrites found data)
  const metadata = {
    ...existingData.metadata,
    employeeName: existingData.metadata.employeeName || (text.match(NAME_RE)?.[1]?.trim() ?? ''),
    period:       existingData.metadata.period       || (text.match(PERIOD_RE)?.[1]?.trim() ?? ''),
    status:       existingData.metadata.status       || (text.match(STATUS_RE)?.[1]?.trim() ?? ''),
  };

  const ocrEntries = parseEntries(text);
  // Keep whichever source gave more entries
  const entries: TimesheetEntry[] =
    ocrEntries.length > existingData.entries.length ? ocrEntries : existingData.entries;

  const ocrTotal     = text.match(TOTAL_RE) ? parseFloat(text.match(TOTAL_RE)![1]!) : 0;
  const computedTotal = entries.reduce((s, e) => s + e.hours, 0);

  return {
    ...existingData,
    metadata,
    entries,
    totals: {
      ...existingData.totals,
      total: ocrTotal || computedTotal || existingData.totals.total,
    },
  };
}
