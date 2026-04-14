// ─────────────────────────────────────────────────────────────────────────────
// config.ts — Load and validate all configuration from environment
// ─────────────────────────────────────────────────────────────────────────────

import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

dotenv.config();

function require_env(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

function optional_env(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

// ── Resolve and ensure output directory ──────────────────────────────────────

const OUTPUT_DIR = path.resolve(optional_env('OUTPUT_DIR', './output'));
const DIRS = {
  root: OUTPUT_DIR,
  json: path.join(OUTPUT_DIR, 'json'),
  screenshots: path.join(OUTPUT_DIR, 'screenshots'),
  html: path.join(OUTPUT_DIR, 'html'),
  logs: path.join(OUTPUT_DIR, 'logs'),
};

for (const dir of Object.values(DIRS)) {
  fs.mkdirSync(dir, { recursive: true });
}

// ── Export ────────────────────────────────────────────────────────────────────

export const config = {
  beeline: {
    url: optional_env('BEELINE_URL', 'https://app2.beeline.com'),
    username: require_env('BEELINE_USERNAME'),
    password: require_env('BEELINE_PASSWORD'),
  },

  anthropic: {
    apiKey: optional_env('ANTHROPIC_API_KEY', ''),
    model: 'claude-opus-4-5' as const,
    maxTokens: 2048,
  },

  scraper: {
    maxConcurrency: parseInt(optional_env('MAX_CONCURRENCY', '3'), 10),
    confidenceThreshold: parseFloat(optional_env('CONFIDENCE_THRESHOLD', '0.80')),
    maxRetries: parseInt(optional_env('MAX_RETRIES', '3'), 10),
    dateFrom: optional_env('DATE_FROM', ''),
    dateTo: optional_env('DATE_TO', ''),
  },

  browser: {
    headless: optional_env('HEADLESS', 'true') === 'true',
    slowMo: parseInt(optional_env('SLOW_MO_MS', '0'), 10),
    timeout: 30_000,
    navigationTimeout: 45_000,
  },

  output: DIRS,
} as const;

export type Config = typeof config;
