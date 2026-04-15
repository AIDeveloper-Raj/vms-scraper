// ─────────────────────────────────────────────────────────────────────────────
// fallback/llmParser.ts — LLM fallback using OpenAI gpt-5.4-mini (vision)
//
// Sends the full-page screenshot + trimmed HTML to OpenAI.
// Returns strict JSON matching TimesheetData shape.
// ─────────────────────────────────────────────────────────────────────────────

import OpenAI from 'openai';
import * as fs from 'fs/promises';
import type { TimesheetData, TimesheetEntry, EarningsCode } from '../types';
import { config } from '../config';
import { logger } from '../utils/logger';
import { buildNormalizer } from '../utils/earningsNormalizer';
import { parseDate } from '../parsers/dateParser';

const normalize = buildNormalizer();

// ── Lazy client — missing key won't crash on import ───────────────────────────
let _client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!_client) {
    if (!config.openai.apiKey) {
      throw new Error('OPENAI_API_KEY is not set — LLM fallback unavailable');
    }
    _client = new OpenAI({ apiKey: config.openai.apiKey });
  }
  return _client;
}

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a precise timesheet data extractor for VMS portals.
You will receive a screenshot and/or HTML of a timesheet page.
Return ONLY a single valid JSON object — no markdown fences, no explanation, no preamble.

Required JSON schema:
{
  "employeeName": "string",
  "timesheetId": "string or empty string",
  "period": "string (date range exactly as shown on screen)",
  "periodStart": "YYYY-MM-DD or empty string",
  "periodEnd": "YYYY-MM-DD or empty string",
  "status": "string",
  "client": "string or empty string",
  "project": "string or empty string",
  "entries": [
    { "date": "YYYY-MM-DD", "hours": <number>, "rawType": "string as shown", "notes": "string or empty" }
  ],
  "totals": { "regular": <number>, "ot": <number>, "dt": <number>, "total": <number> }
}

Rules:
- All dates MUST be YYYY-MM-DD
- hours MUST be a number (decimal OK, e.g. 7.5)
- Empty string "" for any text field not visible
- 0 for any numeric field not visible
- Do NOT invent or guess — only extract what is clearly visible`;

// ── HTML trimmer ──────────────────────────────────────────────────────────────
function trimHtml(html: string, maxChars = 10_000): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, maxChars);
}

// ── Response typing + coercion ────────────────────────────────────────────────
interface LlmResponse {
  employeeName?: string;
  timesheetId?: string;
  period?: string;
  periodStart?: string;
  periodEnd?: string;
  status?: string;
  client?: string;
  project?: string;
  entries?: Array<{ date?: string; hours?: number | string; rawType?: string; notes?: string }>;
  totals?: { regular?: number; ot?: number; dt?: number; total?: number };
}

function coerceEntries(raw: LlmResponse['entries'] = []): TimesheetEntry[] {
  return raw
    .filter((e) => e.date && e.hours !== undefined)
    .map((e) => {
      const rawType = e.rawType ?? 'REG';
      const hours = typeof e.hours === 'string' ? parseFloat(e.hours) : (e.hours ?? 0);
      return {
        date:    parseDate(e.date ?? ''),
        hours:   isNaN(hours) ? 0 : hours,
        rawType,
        type:    normalize(rawType) as EarningsCode,
        notes:   e.notes || undefined,
      };
    });
}

// ── Public ────────────────────────────────────────────────────────────────────
export async function runLlmFallback(
  screenshotPath: string,
  html: string,
  existingData: TimesheetData,
): Promise<TimesheetData> {
  logger.info(`[LLM] Calling OpenAI ${config.openai.model}…`);

  const client = getClient();
  const base64Image = (await fs.readFile(screenshotPath)).toString('base64');

  const response = await client.chat.completions.create({
    model:      config.openai.model,
    max_tokens: config.openai.maxTokens,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {
              url:    `data:image/png;base64,${base64Image}`,
              detail: 'high', // high-res for table data accuracy
            },
          },
          {
            type: 'text',
            text: `Page HTML (truncated for reference):\n\n${trimHtml(html)}\n\nExtract the timesheet data as JSON.`,
          },
        ],
      },
    ],
  });

  const rawText = response.choices[0]?.message?.content ?? '';
  logger.debug(`[LLM] finish_reason=${response.choices[0]?.finish_reason} | chars=${rawText.length}`);

  // Strip any accidental markdown fences
  const cleaned = rawText.replace(/```(?:json)?/gi, '').trim();

  let parsed: LlmResponse;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(
      `OpenAI returned non-JSON: ${(err as Error).message}\nPreview: ${rawText.slice(0, 300)}`,
    );
  }

  const entries      = coerceEntries(parsed.entries);
  const computedTotal = entries.reduce((s, e) => s + e.hours, 0);

  return {
    ...existingData,
    metadata: {
      ...existingData.metadata,
      employeeName: parsed.employeeName || existingData.metadata.employeeName,
      timesheetId:  parsed.timesheetId  || existingData.metadata.timesheetId,
      period:       parsed.period       || existingData.metadata.period,
      periodStart:  parsed.periodStart  || existingData.metadata.periodStart,
      periodEnd:    parsed.periodEnd    || existingData.metadata.periodEnd,
      status:       parsed.status       || existingData.metadata.status,
      client:       parsed.client       || existingData.metadata.client,
      project:      parsed.project      || existingData.metadata.project,
    },
    entries: entries.length >= existingData.entries.length ? entries : existingData.entries,
    totals: {
      regular:  parsed.totals?.regular  ?? existingData.totals.regular,
      ot:       parsed.totals?.ot       ?? existingData.totals.ot,
      dt:       parsed.totals?.dt       ?? existingData.totals.dt,
      holiday:  existingData.totals.holiday,
      sick:     existingData.totals.sick,
      vacation: existingData.totals.vacation,
      total:    parsed.totals?.total    ?? computedTotal,
    },
  };
}
