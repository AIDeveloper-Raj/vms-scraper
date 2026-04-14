// ─────────────────────────────────────────────────────────────────────────────
// browser/browserManager.ts — Centralized Playwright lifecycle
// ─────────────────────────────────────────────────────────────────────────────

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { config } from '../config';
import { logger } from '../utils/logger';

let _browser: Browser | null = null;

export async function getBrowser(): Promise<Browser> {
  if (_browser) return _browser;

  logger.info('Launching Chromium browser…');
  _browser = await chromium.launch({
    headless: config.browser.headless,
    slowMo: config.browser.slowMo,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox',
    ],
  });

  _browser.on('disconnected', () => {
    logger.warn('Browser disconnected');
    _browser = null;
  });

  return _browser;
}

export async function newContext(): Promise<BrowserContext> {
  const browser = await getBrowser();

  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    acceptDownloads: false,
  });

  // Remove automation fingerprint signals
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  ctx.setDefaultTimeout(config.browser.timeout);
  ctx.setDefaultNavigationTimeout(config.browser.navigationTimeout);

  return ctx;
}

export async function newPage(ctx?: BrowserContext): Promise<{ page: Page; context: BrowserContext }> {
  const context = ctx ?? await newContext();
  const page = await context.newPage();

  // Intercept and block unnecessary assets (speeds up scraping significantly)
  await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf,otf}', (route) => {
    // Allow screenshots to work but skip background assets
    route.abort();
  });
  await page.route('**/{analytics,tracking,ads,telemetry}**', (route) => {
    route.abort();
  });

  return { page, context };
}

export async function closeBrowser(): Promise<void> {
  if (_browser) {
    logger.info('Closing browser…');
    await _browser.close();
    _browser = null;
  }
}
