// ─────────────────────────────────────────────────────────────────────────────
// utils/earningsNormalizer.ts — Map raw VMS labels → standard codes
// ─────────────────────────────────────────────────────────────────────────────

import type { EarningsCode, VMSStructure } from '../types';

// Default fallback map (merged with structure-specific maps at runtime)
const DEFAULT_MAP: Record<EarningsCode, string[]> = {
  REG:     ['reg', 'regular', 'st', 'standard', 'straight time', 'normal', 'base', 'rt'],
  OT:      ['ot', 'overtime', 'over time', 'time and a half', '1.5x', 'ot1'],
  DT:      ['dt', 'double time', 'doubletime', '2x', 'dt1'],
  HOL:     ['hol', 'holiday', 'public holiday', 'bank holiday'],
  SICK:    ['sick', 'sick time', 'sick leave', 'illness'],
  VAC:     ['vac', 'vacation', 'pto', 'paid time off', 'annual leave'],
  UNKNOWN: [],
};

export function buildNormalizer(structure?: VMSStructure) {
  // Merge structure-specific aliases over defaults
  const map: Record<EarningsCode, string[]> = { ...DEFAULT_MAP };

  if (structure?.earningsCodeMap) {
    for (const [code, aliases] of Object.entries(structure.earningsCodeMap) as [EarningsCode, string[]][]) {
      map[code] = [...(map[code] ?? []), ...aliases];
    }
  }

  return function normalize(raw: string): EarningsCode {
    const lower = raw.toLowerCase().trim();

    for (const [code, aliases] of Object.entries(map) as [EarningsCode, string[]][]) {
      if (code === 'UNKNOWN') continue;
      if (aliases.some((alias) => lower === alias || lower.includes(alias))) {
        return code;
      }
    }

    return 'UNKNOWN';
  };
}
