// ─────────────────────────────────────────────────────────────────────────────
// utils/runLock.ts
// File-based lock per account. If a run is already in progress for an account,
// the next scheduled trigger skips gracefully instead of doubling up.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs   from 'fs';
import * as path from 'path';
import { logger } from './logger';

const LOCK_DIR = path.resolve(process.env['OUTPUT_DIR'] ?? './output', 'locks');

function lockPath(account: string): string {
  fs.mkdirSync(LOCK_DIR, { recursive: true });
  return path.join(LOCK_DIR, `${account}.lock`);
}

export function acquireLock(account: string): boolean {
  const lp = lockPath(account);

  // Check for stale lock (older than 3 hours — safety net for crash without cleanup)
  if (fs.existsSync(lp)) {
    const stat = fs.statSync(lp);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs < 3 * 60 * 60 * 1000) {
      logger.warn(`[${account}] Lock exists — previous run still in progress. Skipping.`);
      return false;
    }
    logger.warn(`[${account}] Stale lock found (${Math.round(ageMs / 60000)}m old) — clearing.`);
  }

  fs.writeFileSync(lp, new Date().toISOString(), 'utf-8');
  logger.debug(`[${account}] Lock acquired`);
  return true;
}

export function releaseLock(account: string): void {
  const lp = lockPath(account);
  try {
    if (fs.existsSync(lp)) {
      fs.unlinkSync(lp);
      logger.debug(`[${account}] Lock released`);
    }
  } catch {
    // Non-fatal
  }
}

export function isLocked(account: string): boolean {
  const lp = lockPath(account);
  if (!fs.existsSync(lp)) return false;
  const stat = fs.statSync(lp);
  return (Date.now() - stat.mtimeMs) < 3 * 60 * 60 * 1000;
}
