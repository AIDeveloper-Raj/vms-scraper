// ─────────────────────────────────────────────────────────────────────────────
// utils/fgHoursParser.ts — Fieldglass hours format normaliser
//
// Two formats observed across accounts:
//   ABO/Abbott:  "8h 0m"  "7h 50m"  "0h 0m"  "39h 50m"
//   AMD:         "8.00"   "40.00"   "0.00"   "-"
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert any Fieldglass hours string to a decimal number.
 * Returns 0 for empty, dash, or unparseable input.
 */
export function parseFgHours(raw: string): number {
  const s = (raw ?? '').trim();

  if (!s || s === '-' || s === '') return 0;

  // Format: "8h 0m" | "7h 50m" | "39h 50m" | "0h 0m"
  const hmMatch = s.match(/^(\d+)h\s*(\d+)m$/i);
  if (hmMatch) {
    const hours   = parseInt(hmMatch[1]!, 10);
    const minutes = parseInt(hmMatch[2]!, 10);
    return Math.round((hours + minutes / 60) * 100) / 100;
  }

  // Format: "8.00" | "40.00" | "0.00"
  const decimal = parseFloat(s.replace(/[^0-9.-]/g, ''));
  return isNaN(decimal) ? 0 : Math.round(decimal * 100) / 100;
}

/**
 * Parse the column date header text into a full ISO date.
 * Headers observed:
 *   ABO: "3/30" with separator "Mon" on next line  → need year from period
 *   AMD: "4-06" with "Mon" on next line             → need year from period
 *
 * @param headerText  e.g. "3/30" or "4-06"
 * @param periodYear  4-digit year string derived from the timesheet period
 */
export function parseFgColumnDate(headerText: string, periodYear: string): string {
  const s = headerText.trim().replace(/\s*(Mon|Tue|Wed|Thu|Fri|Sat|Sun).*/i, '').trim();

  // M/DD or M-DD or MM/DD or MM-DD
  const parts = s.split(/[\/\-]/);
  if (parts.length === 2) {
    const m = parts[0]!.padStart(2, '0');
    const d = parts[1]!.padStart(2, '0');
    return `${periodYear}-${m}-${d}`;
  }

  return s; // fallback — return raw
}

/**
 * Extract the 4-digit year from a Fieldglass period string.
 * Handles:
 *   "03/30/2026 to 04/05/2026"
 *   "2026-04-06 to 2026-04-12"
 */
export function extractYearFromPeriod(period: string): string {
  const m = period.match(/\b(20\d{2})\b/);
  return m ? m[1]! : new Date().getFullYear().toString();
}
