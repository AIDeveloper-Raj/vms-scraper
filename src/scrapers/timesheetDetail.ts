// ─────────────────────────────────────────────────────────────────────────────
// scrapers/timesheetDetail.ts
//   1. Navigate to detail page
//   2. Run selector-waterfall parser
//   3. Score confidence
//   4. If below threshold → OCR fallback → LLM fallback
//   5. Save screenshot + HTML
// ─────────────────────────────────────────────────────────────────────────────

import * as path from 'path';
import * as fs from 'fs/promises';
import type { Page } from 'playwright';
import type { VMSStructure, TimesheetData, TimesheetListItem } from '../types';
import { config } from '../config';
import { taskLogger } from '../utils/logger';
import { parseTimesheetDetail } from '../parsers/parserEngine';
import { scoreConfidence } from '../utils/confidence';
import { runOcrFallback } from '../fallback/ocrParser';
import { runLlmFallback } from '../fallback/llmParser';

export async function scrapeTimesheetDetail(
  page: Page,
  item: TimesheetListItem,
  structure: VMSStructure,
): Promise<TimesheetData> {
  const log = taskLogger(item.timesheetId);
  const scrapedAt = new Date().toISOString();

  log.info(`→ Navigating to ${item.url}`);
  await page.goto(item.url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1_000); // let JS render

  // ── Level 1: Selector-based extraction ───────────────────────────────────
  log.debug('Running selector-waterfall parser…');
  let data = await parseTimesheetDetail(page, structure, {
    timesheetId: item.timesheetId,
    url: item.url,
    scrapedAt,
  });

  const report1 = scoreConfidence(data);
  data.confidence = report1.score;
  log.info(`Selector parse confidence: ${(report1.score * 100).toFixed(1)}%`, {
    missing: report1.missingRequired,
    failures: report1.validationFailures,
  });

  // ── Save screenshot + HTML (always, before any fallback) ──────────────────
  const screenshotPath = path.join(config.output.screenshots, `${item.timesheetId}.png`);
  const htmlPath = path.join(config.output.html, `${item.timesheetId}.html`);

  await page.screenshot({ path: screenshotPath, fullPage: true });
  const html = await page.content();
  await fs.writeFile(htmlPath, html, 'utf-8');

  data.screenshotPath = screenshotPath;
  data.htmlPath = htmlPath;
  log.debug(`Screenshot: ${screenshotPath}`);

  if (data.confidence >= config.scraper.confidenceThreshold) {
    log.info(`✓ Confidence OK (${(data.confidence * 100).toFixed(1)}%) — no fallback needed`);
    return data;
  }

  // ── Level 2: OCR fallback ─────────────────────────────────────────────────
  log.warn(`Low confidence (${(data.confidence * 100).toFixed(1)}%) — attempting OCR fallback…`);

  try {
    const ocrData = await runOcrFallback(screenshotPath, data);
    const report2 = scoreConfidence(ocrData);
    ocrData.confidence = report2.score;
    log.info(`OCR fallback confidence: ${(report2.score * 100).toFixed(1)}%`);

    if (report2.score > data.confidence) {
      data = { ...ocrData, fallbackUsed: 'ocr', screenshotPath, htmlPath };
    }
  } catch (err) {
    log.warn(`OCR fallback failed: ${err instanceof Error ? err.message : err}`);
  }

  if (data.confidence >= config.scraper.confidenceThreshold) {
    log.info(`✓ OCR fallback confidence OK (${(data.confidence * 100).toFixed(1)}%)`);
    return data;
  }

  // ── Level 3: LLM fallback ─────────────────────────────────────────────────
  if (!config.openai.apiKey) {
    log.warn('LLM fallback skipped — ANTHROPIC_API_KEY not set');
    return data;
  }

  log.warn(`Still low confidence (${(data.confidence * 100).toFixed(1)}%) — attempting LLM fallback…`);

  try {
    const llmData = await runLlmFallback(screenshotPath, html, data);
    const report3 = scoreConfidence(llmData);
    llmData.confidence = report3.score;
    log.info(`LLM fallback confidence: ${(report3.score * 100).toFixed(1)}%`);

    if (report3.score > data.confidence) {
      data = { ...llmData, fallbackUsed: 'llm', screenshotPath, htmlPath };
    }
  } catch (err) {
    log.error(`LLM fallback failed: ${err instanceof Error ? err.message : err}`);
  }

  log.info(`Final confidence: ${(data.confidence * 100).toFixed(1)}% [fallback: ${data.fallbackUsed}]`);
  return data;
}
