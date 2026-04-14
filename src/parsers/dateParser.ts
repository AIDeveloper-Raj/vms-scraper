// ─────────────────────────────────────────────────────────────────────────────
// parsers/dateParser.ts — Normalise varied VMS date strings → ISO YYYY-MM-DD
// ─────────────────────────────────────────────────────────────────────────────

const MONTH_MAP: Record<string, string> = {
  jan: '01', january: '01',
  feb: '02', february: '02',
  mar: '03', march: '03',
  apr: '04', april: '04',
  may: '05',
  jun: '06', june: '06',
  jul: '07', july: '07',
  aug: '08', august: '08',
  sep: '09', september: '09',
  oct: '10', october: '10',
  nov: '11', november: '11',
  dec: '12', december: '12',
};

function pad(n: number | string): string {
  return String(n).padStart(2, '0');
}

/**
 * Convert a raw date string into ISO YYYY-MM-DD.
 * Returns the raw string unchanged if no format matches.
 */
export function parseDate(raw: string): string {
  const s = raw.trim();

  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // MM/DD/YYYY or M/D/YYYY
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) return `${mdy[3]}-${pad(mdy[1])}-${pad(mdy[2])}`;

  // DD/MM/YYYY (less common in US portals, but included)
  // We assume MM/DD for US portals — adjust if needed

  // MM-DD-YYYY
  const mdyDash = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (mdyDash) return `${mdyDash[3]}-${pad(mdyDash[1])}-${pad(mdyDash[2])}`;

  // "Jan 1, 2024" or "January 1 2024"
  const longDate = s.match(/^([A-Za-z]+)\s+(\d{1,2})[,\s]+(\d{4})$/);
  if (longDate) {
    const m = MONTH_MAP[longDate[1]!.toLowerCase()];
    if (m) return `${longDate[3]}-${m}-${pad(longDate[2])}`;
  }

  // "1 Jan 2024"
  const revLong = s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (revLong) {
    const m = MONTH_MAP[revLong[2]!.toLowerCase()];
    if (m) return `${revLong[3]}-${m}-${pad(revLong[1])}`;
  }

  // YYYYMMDD
  if (/^\d{8}$/.test(s)) {
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }

  return s; // unknown — return as-is
}
