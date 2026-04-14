// ─────────────────────────────────────────────────────────────────────────────
// types.ts — All shared interfaces and enums
// ─────────────────────────────────────────────────────────────────────────────

export type EarningsCode = 'REG' | 'OT' | 'DT' | 'HOL' | 'SICK' | 'VAC' | 'UNKNOWN';
export type FallbackMethod = 'none' | 'ocr' | 'llm';
export type TaskStatus = 'pending' | 'running' | 'done' | 'failed';

// ── Timesheet Data ────────────────────────────────────────────────────────────

export interface TimesheetEntry {
  date: string;          // ISO: YYYY-MM-DD
  dayOfWeek?: string;
  hours: number;
  type: EarningsCode;    // normalized
  rawType: string;       // as-scraped, before normalization
  notes?: string;
}

export interface TimesheetTotals {
  regular: number;
  ot: number;
  dt: number;
  holiday: number;
  sick: number;
  vacation: number;
  total: number;
}

export interface TimesheetMetadata {
  timesheetId: string;
  employeeName: string;
  workerId?: string;
  status: string;
  period: string;         // e.g. "2024-01-01 to 2024-01-07"
  periodStart?: string;   // ISO
  periodEnd?: string;     // ISO
  client?: string;
  project?: string;
  url: string;
  scrapedAt: string;      // ISO timestamp
}

export interface TimesheetData {
  metadata: TimesheetMetadata;
  entries: TimesheetEntry[];
  totals: TimesheetTotals;
  confidence: number;         // 0.0 – 1.0
  fallbackUsed: FallbackMethod;
  screenshotPath?: string;
  htmlPath?: string;
}

// ── Scrape Results ────────────────────────────────────────────────────────────

export interface ScrapeResult {
  success: boolean;
  data?: TimesheetData;
  error?: string;
  timesheetId: string;
  url: string;
  attempts: number;
}

export interface TimesheetListItem {
  timesheetId: string;
  url: string;
  period?: string;
  status?: string;
  employeeName?: string;
}

// ── Structure Map (JSON-driven parser) ───────────────────────────────────────

export interface FieldDefinition {
  selectors: string[];          // CSS selectors tried in order
  required: boolean;
  transform?: 'number' | 'text' | 'date' | 'trim';
  pattern?: string;             // optional regex to validate extracted value
}

export interface RowFieldDefinition extends FieldDefinition {
  cellIndex?: number;           // fallback: nth <td> in the row
}

export interface RowStructure {
  containerSelector: string[];  // selectors for the <tbody> or row container
  rowSelector: string;          // selector for each row within container
  skipIfEmpty: boolean;
  fields: Record<string, RowFieldDefinition>;
}

export interface VMSStructure {
  name: string;
  version: string;
  loginSelectors: {
    usernameField: string[];
    passwordField: string[];
    submitButton: string[];
    successIndicator: string[];
  };
  navigation: {
    timesheetMenuPath: string[];   // selectors to click in order to reach timesheet list
    timesheetListUrl?: string;     // optional direct URL after login
  };
  listPage: {
    tableContainer: string[];
    rowSelector: string;
    columns: {
      timesheetId: RowFieldDefinition;
      period: RowFieldDefinition;
      status: RowFieldDefinition;
      employeeName: RowFieldDefinition;
      link: RowFieldDefinition;    // href for detail page
    };
    dateFilterFrom?: string[];
    dateFilterTo?: string[];
    applyFilterButton?: string[];
    nextPageButton?: string[];
  };
  detailPage: {
    employeeName: FieldDefinition;
    timesheetId: FieldDefinition;
    period: FieldDefinition;
    status: FieldDefinition;
    client?: FieldDefinition;
    project?: FieldDefinition;
    entriesTable: RowStructure;
    totals: {
      regular: FieldDefinition;
      ot: FieldDefinition;
      dt?: FieldDefinition;
      total: FieldDefinition;
    };
  };
  earningsCodeMap: Record<EarningsCode, string[]>;
}

// ── Task Queue ────────────────────────────────────────────────────────────────

export interface ScraperTask {
  id: string;
  timesheetId: string;
  url: string;
  status: TaskStatus;
  attempts: number;
  result?: ScrapeResult;
  error?: string;
}

// ── Confidence ────────────────────────────────────────────────────────────────

export interface ConfidenceReport {
  score: number;
  missingRequired: string[];
  missingOptional: string[];
  validationFailures: string[];
  fieldCoverage: number;      // 0–1
  hoursValidation: boolean;
}
