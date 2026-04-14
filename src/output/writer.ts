// ─────────────────────────────────────────────────────────────────────────────
// output/writer.ts — Persist results to disk + emit console summary
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'fs/promises';
import * as path from 'path';
import type { ScrapeResult, TimesheetData } from '../types';
import { config } from '../config';
import { logger } from '../utils/logger';

// ── Individual timesheet ──────────────────────────────────────────────────────

export async function writeResult(result: ScrapeResult): Promise<void> {
  if (!result.data) return;

  const filePath = path.join(config.output.json, `${sanitizeId(result.timesheetId)}.json`);
  await fs.writeFile(filePath, JSON.stringify(result.data, null, 2), 'utf-8');

  logger.info(`💾  ${result.timesheetId} → ${filePath}`);
  printTimesheetSummary(result.data);
}

// ── Run summary ───────────────────────────────────────────────────────────────

export async function writeSummary(
  passed: ScrapeResult[],
  failed: ScrapeResult[],
): Promise<void> {
  const summary = {
    runAt: new Date().toISOString(),
    totalDiscovered: passed.length + failed.length,
    passed: passed.length,
    failed: failed.length,
    averageConfidence:
      passed.length > 0
        ? Math.round(
            (passed.reduce((s, r) => s + (r.data?.confidence ?? 0), 0) / passed.length) * 100,
          ) / 100
        : null,
    fallbackBreakdown: {
      none:  passed.filter((r) => r.data?.fallbackUsed === 'none').length,
      ocr:   passed.filter((r) => r.data?.fallbackUsed === 'ocr').length,
      llm:   passed.filter((r) => r.data?.fallbackUsed === 'llm').length,
    },
    failedItems: failed.map((f) => ({
      timesheetId: f.timesheetId,
      url: f.url,
      error: f.error ?? 'unknown',
      attempts: f.attempts,
    })),
  };

  const summaryPath = path.join(config.output.root, 'summary.json');
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf-8');

  printRunSummary(summary);
  logger.info(`📊  Summary → ${summaryPath}`);
}

// ── Console printing ──────────────────────────────────────────────────────────

function printTimesheetSummary(d: TimesheetData): void {
  const confBar = confidenceBar(d.confidence);
  const fallbackTag =
    d.fallbackUsed === 'none' ? '' : ` [via ${d.fallbackUsed.toUpperCase()}]`;

  console.log('\n' + '─'.repeat(56));
  console.log(`  ${d.metadata.employeeName || '(name unknown)'}`);
  console.log(`  Period   : ${d.metadata.period}`);
  console.log(`  Status   : ${d.metadata.status}`);
  console.log(`  Entries  : ${d.entries.length} rows`);
  console.log(`  Hours    : REG ${d.totals.regular} | OT ${d.totals.ot} | DT ${d.totals.dt} | Total ${d.totals.total}`);
  console.log(`  Confidence ${confBar} ${(d.confidence * 100).toFixed(1)}%${fallbackTag}`);

  if (d.entries.length > 0) {
    console.log('  Sample entries:');
    d.entries.slice(0, 3).forEach((e) =>
      console.log(`    ${e.date}  ${String(e.hours).padStart(5)}h  ${e.type.padEnd(8)} (${e.rawType})`),
    );
    if (d.entries.length > 3) console.log(`    … and ${d.entries.length - 3} more`);
  }
  console.log('─'.repeat(56) + '\n');
}

function printRunSummary(s: {
  runAt: string;
  totalDiscovered: number;
  passed: number;
  failed: number;
  averageConfidence: number | null;
  fallbackBreakdown: { none: number; ocr: number; llm: number };
  failedItems: Array<{ timesheetId: string; error: string }>;
}): void {
  console.log('\n' + '═'.repeat(56));
  console.log('  SCRAPE RUN COMPLETE');
  console.log('═'.repeat(56));
  console.log(`  Total discovered : ${s.totalDiscovered}`);
  console.log(`  ✓ Passed         : ${s.passed}`);
  console.log(`  ✗ Failed         : ${s.failed}`);
  console.log(`  Avg confidence   : ${s.averageConfidence !== null ? (s.averageConfidence * 100).toFixed(1) + '%' : 'N/A'}`);
  console.log(`  Extraction method:`);
  console.log(`    Selectors only : ${s.fallbackBreakdown.none}`);
  console.log(`    OCR fallback   : ${s.fallbackBreakdown.ocr}`);
  console.log(`    LLM fallback   : ${s.fallbackBreakdown.llm}`);

  if (s.failedItems.length > 0) {
    console.log('\n  Failed timesheets:');
    s.failedItems.forEach((f) => console.log(`    ✗ ${f.timesheetId}: ${f.error}`));
  }
  console.log('═'.repeat(56) + '\n');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function confidenceBar(score: number): string {
  const filled = Math.round(score * 10);
  return '[' + '█'.repeat(filled) + '░'.repeat(10 - filled) + ']';
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}
