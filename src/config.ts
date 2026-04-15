import * as dotenv from 'dotenv';
import * as path   from 'path';
import * as fs     from 'fs';

dotenv.config();

function require_env(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}
function optional_env(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

const OUTPUT_DIR = path.resolve(optional_env('OUTPUT_DIR', './output'));
const DIRS = {
  root:        OUTPUT_DIR,
  json:        path.join(OUTPUT_DIR, 'json'),
  screenshots: path.join(OUTPUT_DIR, 'screenshots'),
  html:        path.join(OUTPUT_DIR, 'html'),
  logs:        path.join(OUTPUT_DIR, 'logs'),
};
for (const dir of Object.values(DIRS)) fs.mkdirSync(dir, { recursive: true });

export const config = {
  // ── VMS type: 'beeline' | 'fieldglass' ──────────────────────────────────
  vmsType: optional_env('VMS_TYPE', 'fieldglass') as 'beeline' | 'fieldglass',

  // ── Beeline ──────────────────────────────────────────────────────────────
  beeline: {
    url:      optional_env('BEELINE_URL', 'https://app2.beeline.com'),
    username: optional_env('BEELINE_USERNAME', ''),
    password: optional_env('BEELINE_PASSWORD', ''),
  },

  // ── Fieldglass ───────────────────────────────────────────────────────────
  fieldglass: {
    baseUrl:  optional_env('FG_BASE_URL', 'https://www.us.fieldglass.cloud.sap'),
    username: require_env('FG_USERNAME'),
    password: require_env('FG_PASSWORD'),
  },

  // ── OpenAI (LLM fallback) ─────────────────────────────────────────────────
  openai: {
    apiKey:    optional_env('OPENAI_API_KEY', ''),
    model:     optional_env('OPENAI_MODEL', 'gpt-5.4-mini'),
    maxTokens: 2048,
  },

  // ── Google Cloud Vision (OCR fallback) ───────────────────────────────────
  gcp: {
    visionApiKey: optional_env('GCP_VISION_API_KEY', ''),
    projectId:    optional_env('GCP_PROJECT_ID', ''),
  },

  scraper: {
    maxConcurrency:      parseInt(optional_env('MAX_CONCURRENCY', '3'), 10),
    confidenceThreshold: parseFloat(optional_env('CONFIDENCE_THRESHOLD', '0.80')),
    maxRetries:          parseInt(optional_env('MAX_RETRIES', '3'), 10),
    maxRecords:          parseInt(optional_env('MAX_RECORDS', '0'), 10), // 0 = no limit
    dateFrom:            optional_env('DATE_FROM', ''),
    dateTo:              optional_env('DATE_TO', ''),
  },

  browser: {
    headless:          optional_env('HEADLESS', 'true') === 'true',
    slowMo:            parseInt(optional_env('SLOW_MO_MS', '0'), 10),
    timeout:           30_000,
    navigationTimeout: 45_000,
  },

  output: DIRS,
} as const;

export type Config = typeof config;
