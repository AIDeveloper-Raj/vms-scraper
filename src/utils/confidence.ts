// ─────────────────────────────────────────────────────────────────────────────
// utils/confidence.ts — Score extraction quality before deciding on fallback
// ─────────────────────────────────────────────────────────────────────────────

import type { TimesheetData, ConfidenceReport } from '../types';

interface ScoringWeights {
  fieldCoverage: number;    // weight for required + optional field presence
  hoursConsistency: number; // weight for totals matching sum of entries
  entryCount: number;       // weight for having at least 1 entry
  metadataCompleteness: number;
}

const DEFAULT_WEIGHTS: ScoringWeights = {
  fieldCoverage: 0.40,
  hoursConsistency: 0.30,
  entryCount: 0.20,
  metadataCompleteness: 0.10,
};

const REQUIRED_META_FIELDS: (keyof TimesheetData['metadata'])[] = [
  'employeeName',
  'period',
  'status',
];

const OPTIONAL_META_FIELDS: (keyof TimesheetData['metadata'])[] = [
  'timesheetId',
  'periodStart',
  'periodEnd',
  'client',
  'project',
];

export function scoreConfidence(data: TimesheetData): ConfidenceReport {
  const missingRequired: string[] = [];
  const missingOptional: string[] = [];
  const validationFailures: string[] = [];

  // ── 1. Metadata completeness ─────────────────────────────────────────────
  for (const field of REQUIRED_META_FIELDS) {
    if (!data.metadata[field]) missingRequired.push(`metadata.${field}`);
  }
  for (const field of OPTIONAL_META_FIELDS) {
    if (!data.metadata[field]) missingOptional.push(`metadata.${field}`);
  }

  const totalFields = REQUIRED_META_FIELDS.length + OPTIONAL_META_FIELDS.length;
  const foundFields = totalFields - missingRequired.length - missingOptional.length;
  const fieldCoverage = foundFields / totalFields;

  // ── 2. Hours consistency ──────────────────────────────────────────────────
  let hoursValidation = false;
  if (data.entries.length > 0) {
    const entrySum = data.entries.reduce((acc, e) => acc + e.hours, 0);
    const reportedTotal = data.totals.total;

    if (reportedTotal === 0) {
      // No total reported — just check entries are sane (0–24h/day)
      const entriesSane = data.entries.every((e) => e.hours >= 0 && e.hours <= 24);
      hoursValidation = entriesSane;
      if (!entriesSane) validationFailures.push('Some entries have hours outside 0–24 range');
    } else {
      const delta = Math.abs(entrySum - reportedTotal);
      hoursValidation = delta < 0.5; // allow tiny float rounding
      if (!hoursValidation) {
        validationFailures.push(
          `Hours mismatch: entries sum=${entrySum.toFixed(2)}, reported total=${reportedTotal.toFixed(2)}`,
        );
      }
    }
  }

  // ── 3. Entry count ────────────────────────────────────────────────────────
  const hasEntries = data.entries.length > 0;
  if (!hasEntries) validationFailures.push('No timesheet entries found');

  // ── 4. Date validity ──────────────────────────────────────────────────────
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  const badDates = data.entries.filter((e) => !ISO_DATE.test(e.date));
  if (badDates.length > 0) {
    validationFailures.push(`${badDates.length} entries have invalid date format`);
  }

  // ── 5. Composite score ────────────────────────────────────────────────────
  const w = DEFAULT_WEIGHTS;

  const fieldScore = missingRequired.length === 0 ? fieldCoverage : fieldCoverage * 0.5;
  const hoursScore = hoursValidation ? 1 : 0;
  const entryScore = hasEntries ? 1 : 0;
  const metaScore = missingRequired.length === 0 ? 1 : 0.3;

  const score = Math.min(
    1,
    fieldScore   * w.fieldCoverage +
    hoursScore   * w.hoursConsistency +
    entryScore   * w.entryCount +
    metaScore    * w.metadataCompleteness,
  );

  return {
    score: Math.round(score * 100) / 100,
    missingRequired,
    missingOptional,
    validationFailures,
    fieldCoverage: Math.round(fieldCoverage * 100) / 100,
    hoursValidation,
  };
}
