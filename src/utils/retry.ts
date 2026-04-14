// ─────────────────────────────────────────────────────────────────────────────
// utils/retry.ts — Async retry with exponential backoff + jitter
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from './logger';

interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  onRetry?: (attempt: number, error: Error) => void;
  label?: string;
}

const DEFAULT_OPTS: Required<Omit<RetryOptions, 'onRetry' | 'label'>> = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 15_000,
  factor: 2,
};

function jitter(ms: number): number {
  // ±20% random jitter to avoid thundering herd
  return ms + (Math.random() * 0.4 - 0.2) * ms;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = DEFAULT_OPTS.maxAttempts,
    baseDelayMs = DEFAULT_OPTS.baseDelayMs,
    maxDelayMs = DEFAULT_OPTS.maxDelayMs,
    factor = DEFAULT_OPTS.factor,
    onRetry,
    label = 'operation',
  } = opts;

  let lastError: Error = new Error('Retry failed');

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt === maxAttempts) break;

      const rawDelay = Math.min(baseDelayMs * Math.pow(factor, attempt - 1), maxDelayMs);
      const waitMs = Math.round(jitter(rawDelay));

      logger.warn(`[retry] ${label} failed on attempt ${attempt}/${maxAttempts}. Retrying in ${waitMs}ms…`, {
        error: lastError.message,
      });

      onRetry?.(attempt, lastError);
      await delay(waitMs);
    }
  }

  throw lastError;
}
