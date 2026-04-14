// ─────────────────────────────────────────────────────────────────────────────
// fallback/llmParser.ts — Ask Claude to extract timesheet data from
//   a screenshot (vision) + HTML snippet when selectors + OCR fall short.
// ─────────────────────────────────────────────────────────────────────────────

import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs/promises';
import type { TimesheetData, TimesheetEntry, EarningsCode } from '../types';
import { config } from '../config';
import { logger } from '../utils/logger';
import { buildNormalizer } from '../utils/earningsNormalizer';
import { parseDate } from '../parsers/dateParser';

const normalize = buildNormalizer();

// ── Prompt ────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a precise timesheet data extractor.
The user will give you a screenshot and/or HTML of a VMS timesheet page.
Your job is to extract structured timesheet data and return ONLY valid JSON — no markdown, no explanations.

Return this exact JSON schema:
{
  "employeeName": "string",
  "timesheetId": "string or empty",
  "period": "string (date range as shown)",
  "periodStart": "YYYY-MM-DD or empty",
  "periodEnd": "YYYY-MM-DD or empty",
  "status": "string",
  "client": "string or empty",
  "project": "string or empty",
  "entries": [
    { "date": "YYYY-MM-DD", "hours": number, "rawType": "string as shown", "notes": "string or empty" }
  ],
  "totals": {
    "regular": number,
    "ot": number,
    "dt": number,
    "total": number
  }
}

Rules:
- dates must be in YYYY-MM-DD format
- hours must be a number (decimal ok)
- if a field is not visible, use empty string or 0
- do not invent data — only extract what is clearly visible
`;

// ── HTML trimmer — LLM context window is finite ───────────────────────────────

function trimHtml(html: string, maxChars = 12_000): string {
  // Strip <script> and <style> blocks — they add noise
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return stripped.length > maxChars ? stripped.slice(0, maxChars) + '\n...[truncated]' : stripped;
}

// ── Type coercion after LLM response ─────────────────────────────────────────

interface LlmResponse {
  employeeName?: string;
  timesheetId?: string;
  period?: string;
  periodStart?: string;
  periodEnd?: string;
  status?: string;
  client?: string;
  project?: string;
  entries?: Array<{
    date?: string;
    hours?: number | string;
    rawType?: string;
    notes?: string;
  }>;
  totals?: {
    regular?: number;
    ot?: number;
    dt?: number;
    total?: number;
  };
}

function coerceEntries(raw: LlmResponse['entries'] = []): TimesheetEntry[] {
  return raw
    .filter((e) => e.date && e.hours !== undefined)
    .map((e) => {
      const rawType = e.rawType ?? 'REG';
      const hours = typeof e.hours === 'string' ? parseFloat(e.hours) : (e.hours ?? 0);
      return {
        date: parseDate(e.date ?? ''),
        hours: isNaN(hours) ? 0 : hours,
        rawType,
        type: normalize(rawType) as EarningsCode,
        notes: e.notes || undefined,
      };
    });
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function runLlmFallback(
  screenshotPath: string,
  html: string,
  existingData: TimesheetData,
): Promise<TimesheetData> {
  logger.info('Calling Claude LLM for timesheet extraction…');

  const client = new Anthropic({ apiKey: config.anthropic.apiKey });

  const screenshotBuffer = await fs.readFile(screenshotPath);
  const base64Image = screenshotBuffer.toString('base64');
  const trimmedHtml = trimHtml(html);

  const response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: config.anthropic.maxTokens,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: base64Image,
            },
          },
          {
            type: 'text',
            text: `Here is the page HTML (for reference):\n\n${trimmedHtml}\n\nPlease extract the timesheet data.`,
          },
        ],
      },
    ],
  });

  const rawText = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  logger.debug(`LLM raw response length: ${rawText.length} chars`);

  // Parse the JSON response
  let parsed: LlmResponse;
  try {
    // Strip any accidental markdown fences
    const cleaned = rawText.replace(/```(?:json)?/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`LLM returned non-JSON response: ${err instanceof Error ? err.message : err}`);
  }

  const entries = coerceEntries(parsed.entries);
  const computedTotal = entries.reduce((s, e) => s + e.hours, 0);

  // Merge LLM findings over existing data
  return {
    ...existingData,
    metadata: {
      ...existingData.metadata,
      employeeName: parsed.employeeName || existingData.metadata.employeeName,
      timesheetId: parsed.timesheetId || existingData.metadata.timesheetId,
      period: parsed.period || existingData.metadata.period,
      periodStart: parsed.periodStart || existingData.metadata.periodStart,
      periodEnd: parsed.periodEnd || existingData.metadata.periodEnd,
      status: parsed.status || existingData.metadata.status,
      client: parsed.client || existingData.metadata.client,
      project: parsed.project || existingData.metadata.project,
    },
    entries: entries.length >= existingData.entries.length ? entries : existingData.entries,
    totals: {
      regular: parsed.totals?.regular ?? existingData.totals.regular,
      ot: parsed.totals?.ot ?? existingData.totals.ot,
      dt: parsed.totals?.dt ?? existingData.totals.dt,
      holiday: existingData.totals.holiday,
      sick: existingData.totals.sick,
      vacation: existingData.totals.vacation,
      total: parsed.totals?.total ?? computedTotal,
    },
  };
}
