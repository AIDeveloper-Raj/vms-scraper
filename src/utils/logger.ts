// ─────────────────────────────────────────────────────────────────────────────
// utils/logger.ts — Structured Winston logger (console + file)
// ─────────────────────────────────────────────────────────────────────────────

import winston from 'winston';
import * as path from 'path';
import * as fs from 'fs';

const LOG_DIR = process.env['OUTPUT_DIR']
  ? path.join(process.env['OUTPUT_DIR'], 'logs')
  : './output/logs';

fs.mkdirSync(LOG_DIR, { recursive: true });

const { combine, timestamp, printf, colorize, errors } = winston.format;

const consoleFmt = printf(({ level, message, timestamp: ts, timesheetId, ...meta }) => {
  const ctx = timesheetId ? ` [${timesheetId}]` : '';
  const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${ts}${ctx} ${level}: ${message}${extra}`;
});

export const logger = winston.createLogger({
  level: 'debug',
  format: combine(errors({ stack: true }), timestamp({ format: 'HH:mm:ss.SSS' })),
  transports: [
    // ── Console (colourised) ──────────────────────────────────────────────────
    new winston.transports.Console({
      format: combine(colorize(), consoleFmt),
    }),
    // ── File: full debug log ──────────────────────────────────────────────────
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'scraper.log'),
      format: combine(timestamp(), winston.format.json()),
      maxsize: 10 * 1024 * 1024, // 10 MB
      maxFiles: 3,
    }),
    // ── File: errors only ────────────────────────────────────────────────────
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'errors.log'),
      level: 'error',
      format: combine(timestamp(), winston.format.json()),
    }),
  ],
});

// Convenience child logger scoped to a timesheet ID
export function taskLogger(timesheetId: string) {
  return logger.child({ timesheetId });
}
